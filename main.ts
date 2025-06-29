import { Agent, AgentInputItem, AgentsError, run } from "@openai/agents";
import { stringify } from "jsr:@std/yaml";
import { OpenAI } from "openai";
import { setDefaultOpenAIClient } from "@openai/agents";
import { JSONAppender, JSONLAppender, replayJSONL } from "./io-combinators.ts";
import {
  fetchProxyCurlLogger,
  prettyJsonLogger,
} from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from "@openai/agents";
import { DictStore, LoggingStore, Operation, RelativeStore, Store } from "./storage-combinators.ts";

setOpenAIAPI("chat_completions");

const fetchWithPrettyJson = fetchProxyCurlLogger({
  logger: prettyJsonLogger,
});

const params = {
  model: "openai/gpt-4.1-mini",
};

const historyTutorAgent = new Agent({
  ...params,
  name: "History Tutor",
  instructions:
    "You provide assistance with historical queries. Explain important events and context clearly.",
});

const mathTutorAgent = new Agent({
  ...params,
  name: "Math Tutor",
  instructions:
    "You provide help with math problems. Explain your reasoning at each step and include examples",
});

const triageAgent = new Agent({
  ...params,
  name: "Triage Agent",
  instructions:
    "You determine which agent to use based on the user's homework question",
  handoffs: [historyTutorAgent, mathTutorAgent],
});

const programData = new DictStore<string | AgentInputItem>();

const HISTORY_JSONL = "history.jsonl";
interface Message {
  prevID?: string
  item: AgentInputItem
}

interface Chat {
  id: string
  msgID?: string
}

async function main() {
  const memoryStore = new DictStore<Chat | Message>();
  await replayJSONL(HISTORY_JSONL, programData);
  const diskStore = new JSONLAppender(HISTORY_JSONL, memoryStore);
  const chats = new RelativeStore<Chat>(diskStore as any, "chats");
  let currentChat = await (async function () {
    const dbEntry = await chats.get("current");
    if (dbEntry) {
      return dbEntry;
    }
    const newEntry = { id: `${Date.now()}` } as Chat;
    await chats.put("current", newEntry);
    return newEntry;
  })();
  const allMessages = new RelativeStore<Message>(diskStore as any, "messages");
  const chatMessages = new RelativeStore<Message>(allMessages, currentChat.id);

  const msgHistory: AgentInputItem[] = []
  let prevMsgID = currentChat.msgID;
  while (prevMsgID) {
    const msg = await chatMessages.get(prevMsgID)
    if (msg) {
      msgHistory.unshift(msg.item);
    }
    prevMsgID = msg?.prevID;
  }
  const userInput = prompt(">");
  if (!userInput) {
    process.exit(0);
  }
  const msgID = `${Date.now()}`;
  const msg = { type: "message", role: "user", content: userInput.trim() } as AgentInputItem
  await chatMessages.put(msgID, { prevID: currentChat.msgID, item: msg });
  msgHistory.push(msg);
  currentChat = { ...currentChat, msgID };
  await chats.put("current", currentChat);

  process.exit(0);
  const customClient = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: Deno.env.get(
      "OPENROUTER_API_KEY",
    ),
    fetch: fetchWithPrettyJson as any,
  });
  setDefaultOpenAIClient(customClient as any);
  const stream = await run(triageAgent, msgHistory, {
    stream: true,
  });
  // const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
  // textStream.pipe(process.stdout);
  for await (const event of stream) {
    // these are the raw events from the model
    if (event) {
      let text: string = "";
      try {
        text = stringify(event);
      } catch (_e) {
        text = JSON.stringify(event);
      }
      console.log(text);
    }
  }
  await stream.completed;
  console.log("rawResponses:");
  console.log(stringify(stream.rawResponses));
  console.log("history:");
  console.log(stringify(stream.history));
  console.log(stream.finalOutput);
  // console.log(stringify(stream.state))
}

main().catch((err) => {
  if (err instanceof AgentsError && err.state) {
    console.log(err.state);
    console.error(JSON.stringify(err.state));
  } else {
    console.error(err);
  }
});
