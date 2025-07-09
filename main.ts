// deno-lint-ignore-file no-process-global
import { Agent, AgentInputItem, MCPServerStdio, run, tool, webSearchTool } from "@openai/agents";
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';

import { stringify } from "jsr:@std/yaml";
import { parseArgs } from "jsr:@std/cli/parse-args";
import { OpenAI } from "openai";
import { z } from 'zod';
import { setDefaultOpenAIClient } from "@openai/agents";
import { JSONLAppender, replayJSONL } from "./io-combinators.ts";
import {
  fetchProxyCurlLogger,
  prettyJsonLogger,
} from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from "@openai/agents";
import { DictStore, ProxyStore, RelativeStore, Store } from "./storage-combinators.ts";


function stringifyYaml(obj: unknown): string {
  return stringify(obj, { skipInvalid: true });
}

const flags = parseArgs(Deno.args, {
  string: ["provider", "model"],
  boolean: ["trace", "help"],
  alias: { "h": "help" },
});

if (flags.help) {
  console.log(`
Usage: deno run -A main.ts [options]

An interactive chat with OpenAI agents.

Options:
  --provider <name>  Specify the provider (e.g., 'openai', 'openrouter'). Defaults to 'openai'.
  --model <name>     Specify the model to use.
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
  model: flags.model ?? (USE_OPENROUTER ? 'openrouter/cypher-alpha:free' : `${openaiPrefix}gpt-4.1-mini`),
};

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

  const fetchUrlTool = tool({
    name: 'fetch_url',
    description: 'Fetch the content of a given URL using the JS fetch API',
    parameters: z.object({ url: z.string() }),
    async execute({ url }) {
      const fetchUrl = `https://markdown.download/${url}`;
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${fetchUrl}: ${response.statusText}`);
      }
      return await response.text();
    },
  });

  const coder = new Agent({
    ...params,
    name: "Coder Agent",
    tools: [fetchUrlTool],
    instructions:
      `You are an agent for T Code. Given the user's prompt, you should use the tools available to you to answer the user's question.

Notes:
1. IMPORTANT: You should be concise, direct, and to the point, since your responses will be displayed on a command line interface. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as \"The answer is <answer>.\", \"Here is the content of the file...\" or \"Based on the information provided, the answer is...\" or \"Here is what I will do next...\".
2. When relevant, share file names and code snippets relevant to the query
3. Any file paths you return in your final response MUST be absolute. DO NOT use relative paths.
4. Consider multiple approaches to solving problems, prefer ones that minimize amount output, eg reduce info with  shell tools instead  of reading raw files when needed
5. make sure to commit modified files before editing them and also commit after edits
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
    RECOMMENDED_PROMPT_PREFIX + "You determine which agent to use based on the user's question",
  handoffs: agents,
});

agents.push(triageAgent);

type Message = AgentInputItem;

interface Chat {
  id: string
  maxMsgIndex?: number
}

type ProxyClass<T> = new (source: Store<T>) => Store<T>;

/**
 * Store chats with focus on current
 * once we have new current, we archive the "old current"
 */
class Chats extends ProxyStore<Chat> {

  constructor(private chats: Store<Chat>) {
    super(chats);
  }

  async get(key: string): Promise<Chat | null> {
    let ret = await super.get(key);
    if (!ret) {
      if (key === "current") {
        ret = await this.newChat();
      }
    }
    return ret;
  }

  async current(): Promise<Chat> {
    return (await this.get("current"))!;
  }

  async setCurrent(chat: Chat): Promise<void> {
    await this.chats.put("current", chat);
  }

  async newChat() {
    // first archive the current chat
    const currentChat = await super.get("current");
    if (currentChat) {
      super.put(currentChat.id, currentChat);
    }
    const newChat = { id: `${Date.now()}` }
    await this.chats.put("current", newChat);
    return newChat;
  }
}

class History {
  constructor(public chats: Chats, private allMessages: Store<Message>) { }

  async get(): Promise<Message[]> {
    const currentChat = await this.chats.current();
    const maxMsgIndex = currentChat.maxMsgIndex ?? 0;
    const currentMessages = await this.messageStore();
    const ret = [] as Message[];
    for (let i = 0; i <= maxMsgIndex; i++) {
      const msg = await currentMessages.get(i.toString());
      if (msg) {
        ret.push(msg);
      }
    }
    return ret;
  }

  async appendMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    let currentChat = await this.chats.current();
    const currentMessages = await this.messageStore();
    for (const msg of messages) {
      const maxMsgIndex = currentChat.maxMsgIndex === undefined ? 0 : (currentChat.maxMsgIndex + 1)
      currentChat = { ...currentChat, maxMsgIndex };
      await currentMessages.put(maxMsgIndex.toString(), msg);
    }
    await this.chats.setCurrent(currentChat);
  }

  async messageStore(): Promise<Store<Message>> {
    const currentChat = await this.chats.current();
    return new RelativeStore<Message>(this.allMessages, currentChat.id);
  }

  async deleteLastMessage(): Promise<Message | null> {
    const currentChat = await this.chats.current();
    let ret: Message | null = null;
    let maxMsgIndex = currentChat.maxMsgIndex;
    if (maxMsgIndex && maxMsgIndex > 0) {
      const currentMessages = await this.messageStore();
      ret = await currentMessages.get(maxMsgIndex.toString());
      await currentMessages.delete(maxMsgIndex.toString());
      maxMsgIndex -= 1;
    } else {
      maxMsgIndex = undefined;
    }
    if (currentChat.maxMsgIndex !== maxMsgIndex) {
      await this.chats.setCurrent({ ...currentChat, maxMsgIndex });
    }
    return ret;
  }

  static async init(filename: string, proxyClass: ProxyClass<Message>) {
    const memoryStore = new DictStore<Chat | Message>();
    await replayJSONL(filename, memoryStore);
    const diskStore = new JSONLAppender(filename, memoryStore);
    const relativeChats = new RelativeStore<Chat>(diskStore as unknown as Store<Chat>, "chats");
    const allMessages = new proxyClass(new RelativeStore<Message>(diskStore as unknown as Store<Message>, "messages"));

    const chats = new Chats(relativeChats);
    const ret = new History(chats, allMessages)
    return ret;
  }
}

/**
 * THis is written stupidly cos ai wrote it to serve as a demo of switching agents and deleting messages
 */
async function handleCommand(userInput: string, currentAgent: Agent, agents: Agent[], history: History): Promise<Agent> {
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
    const deletedMsg = await history.deleteLastMessage();
    if (deletedMsg) {
      console.log("Deleted last message:");
      console.log(stringifyYaml(deletedMsg));
      console.log("New history:");
      console.log(stringifyYaml(await history.get()));
    } else {
      console.log("No message to delete.");
    }
  } else if (command === "clear") {
    const chat = await history.chats.newChat();
    console.log(`New chat (id:${chat.id}) started.`);
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

class MessagePrinter extends ProxyStore<Message> {
  async put(ref: string, data: Message): Promise<void> {
    await process.stdout.write("\n" + stringifyYaml([data]) + "\n");

    return super.put(ref, data);
  }
}

async function main() {
  const history = await History.init("history.jsonl", MessagePrinter);
  let currentAgent = agents.at(-1)!;

  console.log(stringifyYaml(await history.get()));

  while (true) {
    const userInput = prompt(getPrompt(currentAgent));
    if (userInput === null) { // EOF
      break;
    }
    if (userInput.startsWith("/")) {
      currentAgent = await handleCommand(userInput, currentAgent, agents, history);
    } else if (userInput) {
      const msg = {
        type: "message",
        role: "user",
        content: userInput.trim(),
      } as AgentInputItem;
      await history.appendMessages([msg]);
      const customClient = new OpenAI({
        ...(USE_OPENROUTER
          ? {
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: Deno.env.get(
              "OPENROUTER_API_KEY",
            ),
          }
          : {}),
        fetch: USE_TRACE ? fetchWithPrettyJson : undefined,
      });
      setDefaultOpenAIClient(customClient);
      const msgsBeforeAI = await history.get();
      const stream = await run(currentAgent, msgsBeforeAI, {
        stream: true,
      });
      let historyLength = msgsBeforeAI.length;
      for await (const event of stream) {
        if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
          process.stdout.write(event.data.delta);
        }
        if (historyLength < stream.history.length) {
          const newMessages = stream.history.slice(historyLength);
          historyLength += newMessages.length;
          await history.appendMessages(newMessages);
        }
      }
      await stream.completed;
      console.log(""); // add a newline before reprinting stuff
      const newMessages = stream.history.slice(historyLength);
      // shouldn't have new messages here cos they should all appear during streaming
      await history.appendMessages(newMessages);
    }
  }
}

main().catch((err) => {
  console.error(err);
});
