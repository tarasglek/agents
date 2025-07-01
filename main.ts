// deno-lint-ignore-file no-process-global
import { Agent, AgentInputItem, MCPServerStdio, run, webSearchTool } from "@openai/agents";
import { stringify } from "jsr:@std/yaml";
import { parseArgs } from "jsr:@std/cli/parse-args";
import { OpenAI } from "openai";
import { setDefaultOpenAIClient } from "@openai/agents";
import { JSONLAppender, replayJSONL } from "./io-combinators.ts";
import {
  fetchProxyCurlLogger,
  prettyJsonLogger,
} from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from "@openai/agents";
import { DictStore, RelativeStore, Store } from "./storage-combinators.ts";


function stringifyYaml(obj: unknown): string {
  return stringify(obj, { skipInvalid: true });
}

const flags = parseArgs(Deno.args, {
  string: ["provider"],
  boolean: ["trace", "help"],
  alias: { "h": "help" },
});

if (flags.help) {
  console.log(`
Usage: deno run -A main.ts [options]

An interactive chat with OpenAI agents.

Options:
  --provider <name>  Specify the provider (e.g., 'openai', 'openrouter'). Defaults to 'openai'.
  --trace            Enable tracing of API requests.
  --help, -h         Show this help message.

Commands within the chat:
  /help              Show in-chat command help.
  /agent             List or switch agents.
  /del-last-msg      Delete the last message.
  /clear             Start a new chat.
  /quit              Exit the application.
  `);
  Deno.exit(0);
}

const provider = flags.provider ?? "openai";
const USE_OPENROUTER = provider === "openrouter";
const USE_TRACE = flags.trace ?? false;

let openaiPrefix = '';
if (USE_OPENROUTER) {
  openaiPrefix = 'openai/';
  setOpenAIAPI("chat_completions");
}
const fetchWithPrettyJson = fetchProxyCurlLogger({
  logger: prettyJsonLogger,
});

const params = {
  model: `${openaiPrefix}gpt-4.1-mini`,
};

if (USE_OPENROUTER) {
  params.model = 'openrouter/cypher-alpha:free'
}

const historyTutorAgent = new Agent({
  ...params,
  name: "History Tutor",
  instructions:
    "You provide assistance with historical queries. Explain important events and context clearly. Refuse to help with non-history question",
});

const mathTutorAgent = new Agent({
  ...params,
  name: "Math Tutor",
  instructions:
    "You provide help with math problems. Explain your reasoning at each step and include examples. Refuse to help with non-math questions",
});

const search = new Agent({
  ...params,
  name: "Search Agent",
  tools: [webSearchTool()],
  instructions:
    "You search web and answer questions using info in search results",
});

const agents = [historyTutorAgent, mathTutorAgent, search];

try {
  const cwd = Deno.cwd();
  const server = new MCPServerStdio({
    fullCommand: "rs_filesystem --mcp",
    env: {
      "MCP_RS_FILESYSTEM_ALLOWED_DIRECTORIES": cwd,
    },
  });
  await server.connect();

  const coder = new Agent({
    ...params,
    name: "Coder Agent",
    instructions:
      `You are an agent for T Code. Given the user's prompt, you should use the tools available to you to answer the user's question.

Notes:
1. IMPORTANT: You should be concise, direct, and to the point, since your responses will be displayed on a command line interface. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as \"The answer is <answer>.\", \"Here is the content of the file...\" or \"Based on the information provided, the answer is...\" or \"Here is what I will do next...\".
2. When relevant, share file names and code snippets relevant to the query
3. Any file paths you return in your final response MUST be absolute. DO NOT use relative paths.
4. Consider multiple approaches to solving problems, prefer ones that minimize amount output, eg reduce info with  shell tools instead  of reading raw files when needed
Here is useful information about the environment you are running in:
<env>
Working directory: ${cwd}
Is directory a git repo: Yes
Platform: ${process.platform}
Today's date: ${new Date().toISOString().split("T")[0]}
</env>
`,
    mcpServers: [server],
  });

  agents.push(coder);
} catch (e) {
  console.error(`Failed to load rs_filesystem mcp`, e)
}



const triageAgent = new Agent({
  ...params,
  name: "Triage Agent",
  instructions:
    "You determine which agent to use based on the user's question",
  handoffs: agents,
});

agents.push(triageAgent);

interface Message {
  prevID?: string
  item: AgentInputItem
}

interface Chat {
  id: string
  msgID?: string
}

class Chats {
  private constructor(private currentChat: Chat, private chats: Store<Chat>, private messages: RelativeStore<Message>) {
  }

  static async init(filename: string): Promise<Chats> {
    const memoryStore = new DictStore<Chat | Message>();
    await replayJSONL(filename, memoryStore);
    const diskStore = new JSONLAppender(filename, memoryStore);
    const chats = new RelativeStore<Chat>(diskStore as any, "chats");
    const currentChat = await (async function () {
      const dbEntry = await chats.get("current");
      if (dbEntry) {
        return dbEntry;
      }
      const newEntry = { id: `${Date.now()}` } as Chat;
      return newEntry;
    })();
    const allMessages = new RelativeStore<Message>(diskStore as any, "messages");
    const chatMessages = new RelativeStore<Message>(allMessages, currentChat.id);

    const chat = new Chats(currentChat, chats, chatMessages);
    return chat;
  }

  newChat() {
    // note this will persist once messages are added
    this.currentChat = { id: `${Date.now()}` }
    this.messages = new RelativeStore<Message>(this.messages.source, this.currentChat.id);

    return this.currentChat.id;
  }

  async history(): Promise<AgentInputItem[]> {
    const msgHistory: AgentInputItem[] = []
    let prevMsgID = this.currentChat.msgID;
    while (prevMsgID) {
      const msg = await this.messages.get(prevMsgID)
      if (msg) {
        msgHistory.unshift(msg.item);
      }
      prevMsgID = msg?.prevID;
    }
    return msgHistory;
  }

  /**
   * @returns unique-within-chat msgIDs based on time
   */
  async genMsgId(): Promise<string> {
    // trim ids relative to convo id
    const baseID = `${Date.now() - parseInt(this.currentChat.id)}`;
    let msgID = baseID;
    let i = 0;
    // check if we unique
    while (await this.messages.get(msgID)) {
      msgID = `${baseID}${i++}`;
    }
    return msgID;
  }

  async append(msgs: AgentInputItem[]): Promise<void> {
    for (const msg of msgs) {
      const msgID = await this.genMsgId()
      await this.messages.put(msgID, { prevID: this.currentChat.msgID, item: msg });
      this.currentChat.msgID = msgID
    }
    await this.chats.put("current", this.currentChat);
  }

  async deleteLastMessage(): Promise<Message | null> {
    if (!this.currentChat.msgID) {
      return null;
    }
    const lastMsg = await this.messages.get(this.currentChat.msgID);
    this.currentChat.msgID = lastMsg?.prevID;
    await this.chats.put("current", this.currentChat);
    return lastMsg;
  }
}

/**
 * THis is written stupidly cos ai wrote it to serve as a demo of switching agents and deleting messages
 */
async function handleCommand(userInput: string, currentAgent: Agent, agents: Agent[], chats: Chats): Promise<Agent> {
  const [command, ...args] = userInput.slice(1).split(" ");
  if (command === "help") {
    console.log("Available commands:");
    console.log("/help - Show this help message");
    console.log("/agent - List available agents");
    console.log("/agent <number> - Select an agent");
    console.log("/del-last-msg - Delete the last message");
    console.log("/clear - Start a new chat");
    console.log("/quit - Exit the application");
  } else if (command === "agent") {
    if (args.length === 0) {
      console.log("Available agents:");
      agents.forEach((agent, i) => {
        console.log(`${i}: ${agent.name}`);
      });
      console.log(`Current agent is: ${currentAgent.name}`);
    } else {
      const agentIndex = parseInt(args[0], 10);
      if (
        !isNaN(agentIndex) && agentIndex >= 0 && agentIndex < agents.length
      ) {
        currentAgent = agents[agentIndex];
        console.log(`Switched to agent: ${currentAgent.name}`);
      } else {
        console.log("Invalid agent number.");
      }
    }
  } else if (command === "del-last-msg") {
    const deletedMsg = await chats.deleteLastMessage();
    if (deletedMsg) {
      console.log("Deleted last message:");
      console.log(stringifyYaml(deletedMsg.item));
      console.log("New history:");
      console.log(stringifyYaml(await chats.history()));
    } else {
      console.log("No message to delete.");
    }
  } else if (command === "clear") {
    const id = chats.newChat();
    console.log(`New chat (id:${id}) started.`);
  } else if (command === "quit") {
    Deno.exit(0);
  } else {
    console.log(`Unknown command: ${command}`);
  }
  return currentAgent;
}

function getPrompt(agent: Agent): string {
  const serviceName = USE_OPENROUTER ? "openrouter" : "openai";
  return `(${serviceName}) ${agent.name}> `;
}


async function main() {
  const chats = await Chats.init("history.jsonl");
  let currentAgent = agents.at(-1)!;
  console.log(stringifyYaml(await chats.history()));

  while (true) {
    const userInput = prompt(getPrompt(currentAgent));
    if (userInput === null) { // EOF
      break;
    }
    if (userInput.startsWith("/")) {
      currentAgent = await handleCommand(userInput, currentAgent, agents, chats);
    } else if (userInput) {
      const msg = {
        type: "message",
        role: "user",
        content: userInput.trim(),
      } as AgentInputItem;
      process.stdout.write(stringifyYaml(msg));
      await chats.append([msg]);
      const customClient = new OpenAI({
        ...(USE_OPENROUTER
          ? {
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: Deno.env.get(
              "OPENROUTER_API_KEY",
            ),
          }
          : {}),
        fetch: USE_TRACE ? fetchWithPrettyJson as any : undefined,
      });
      setDefaultOpenAIClient(customClient as any);
      const msgsBeforeAI = await chats.history();
      const stream = await run(currentAgent, msgsBeforeAI, {
        stream: true,
      });
      for await (const event of stream) {
        if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
          process.stdout.write(event.data.delta);
        }
      }
      await stream.completed;
      console.log(""); // add a newline before reprinting stuff
      const newMessages = stream.history.slice(msgsBeforeAI.length);
      if (newMessages.length) {
        await chats.append(newMessages);
        console.log(stringifyYaml(newMessages));
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
});
