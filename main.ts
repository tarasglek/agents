// deno-lint-ignore-file no-process-global
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { Agent, AgentInputItem, run, webSearchTool } from "@openai/agents";
import { stringify } from "jsr:@std/yaml";
import { OpenAI } from "openai";
import { setDefaultOpenAIClient } from "@openai/agents";
import { JSONLAppender, replayJSONL } from "./io-combinators.ts";
import {
  fetchProxyCurlLogger,
  prettyJsonLogger,
} from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from "@openai/agents";
import { DictStore, RelativeStore, Store } from "./storage-combinators.ts";

setOpenAIAPI("chat_completions");

let openaiPrefix = '';
const USE_OPENROUTER = false;

if (USE_OPENROUTER) {
  openaiPrefix = 'openai/';
}
const fetchWithPrettyJson = fetchProxyCurlLogger({
  logger: prettyJsonLogger,
});

const params = {
  model: `${openaiPrefix}gpt-4.1-mini`,
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

const triageAgent = new Agent({
  ...params,
  name: "Triage Agent",
  instructions:
    "You determine which agent to use based on the user's question",
  handoffs: [historyTutorAgent, mathTutorAgent, search],
});


const agents = [historyTutorAgent, mathTutorAgent, search, triageAgent];

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
      console.log(stringify(deletedMsg.item));
      console.log("New history:");
      console.log(stringify(await chats.history()));
    } else {
      console.log("No message to delete.");
    }
  } else if (command === "clear") {
    const id = chats.newChat();
    console.log(`New chat (id:${id}) started.`);
  } else {
    console.log(`Unknown command: ${command}`);
  }
  return currentAgent;
}


async function main() {
  const chats = await Chats.init("history.jsonl");
  let currentAgent = agents.at(-1)!;
  console.log(stringify(await chats.history()));

  const rl = readline.createInterface({ input: stdin, output: stdout });

  process.stdout.write(currentAgent.name + "> ");
  for await (const userInput of rl) {
    if (!userInput) {
      process.stdout.write(currentAgent.name + "> ");
      continue;
    }

    if (userInput.startsWith("/")) {
      currentAgent = await handleCommand(userInput, currentAgent, agents, chats);
      process.stdout.write(currentAgent.name + "> ");
      continue;
    }

    const msg = {
      type: "message",
      role: "user",
      content: userInput.trim(),
    } as AgentInputItem;
    process.stdout.write(stringify(msg));
    await chats.append([msg]);
    const customClient = new OpenAI(USE_OPENROUTER ? {

      baseURL: "https://openrouter.ai/api/v1",
      apiKey: Deno.env.get(
        "OPENROUTER_API_KEY",
      ),
      //  fetch: false ? fetchWithPrettyJson as any : fetch,
    } : {});
    setDefaultOpenAIClient(customClient as any);
    const msgsBeforeAI = await chats.history();
    const stream = await run(currentAgent, msgsBeforeAI, {
      stream: true,
    });
    stream
      .toTextStream({
        compatibleWithNodeStreams: true,
      })
      .pipe(process.stdout);
    await stream.completed;
    console.log(""); // add a newline before reprinting stuff
    const newMessages = stream.history.slice(msgsBeforeAI.length);
    if (newMessages.length) {
      await chats.append(newMessages);
      console.log(stringify(newMessages));
    }
    process.stdout.write(currentAgent.name + ">");
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
});
