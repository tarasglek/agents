// deno-lint-ignore-file no-process-global
import { Agent, AgentInputItem, run } from "@openai/agents";
import { stringify } from "jsr:@std/yaml";
import { OpenAI } from "openai";
import { setDefaultOpenAIClient } from "@openai/agents";
import { JSONLAppender, replayJSONL } from "./io-combinators.ts";
// import {
//   fetchProxyCurlLogger,
//   prettyJsonLogger,
// } from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from "@openai/agents";
import { DictStore, RelativeStore, Store } from "./storage-combinators.ts";

setOpenAIAPI("chat_completions");

// const fetchWithPrettyJson = fetchProxyCurlLogger({
// logger: prettyJsonLogger,
// });

const params = {
  model: "openai/gpt-4.1-mini",
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

const triageAgent = new Agent({
  ...params,
  name: "Triage Agent",
  instructions:
    "You determine which agent to use based on the user's homework question",
  handoffs: [historyTutorAgent, mathTutorAgent],
});

const agents = [historyTutorAgent, mathTutorAgent, triageAgent];

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
}


async function main() {
  const chats = await Chats.init("history.jsonl");
  const currentAgent = agents.at(-1)!;
  console.log(stringify(await chats.history()))
  while (true) {
    const userInput = prompt(">");
    if (!userInput) {
      process.exit(0);
    }

    const msg = { type: "message", role: "user", content: userInput.trim() } as AgentInputItem
    process.stdout.write(stringify(msg));
    await chats.append([msg]);

    const customClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: Deno.env.get(
        "OPENROUTER_API_KEY",
      ),
      // fetch: fetchWithPrettyJson as any,
    });
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
    await stream.completed
    console.log("");// add a newline before reprinting stuff
    const newMessages = stream.history.slice(msgsBeforeAI.length);
    if (newMessages.length) {
      await chats.append(newMessages);
      console.log(stringify(newMessages))
    }
  }
}

main().catch((err) => {
  console.error(err);
});
