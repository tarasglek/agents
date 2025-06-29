// deno-lint-ignore-file no-process-global
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
  await replayJSONL(HISTORY_JSONL, memoryStore);
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
  console.log(stringify(msgHistory))
  while (true) {
    const userInput = prompt(">");
    if (!userInput) {
      process.exit(0);
    }

    const msgID = `${Date.now() - parseInt(currentChat.id)}`;
    const msg = { type: "message", role: "user", content: userInput.trim() } as AgentInputItem
    process.stdout.write(stringify(msg));
    await chatMessages.put(msgID, { prevID: currentChat.msgID, item: msg });
    msgHistory.push(msg);
    currentChat = { ...currentChat, msgID };
    await chats.put("current", currentChat);

    const customClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: Deno.env.get(
        "OPENROUTER_API_KEY",
      ),
      fetch: fetchWithPrettyJson as any,
    });
    setDefaultOpenAIClient(customClient as any);
    console.log("\sassistant:\n");
    const stream = await run(triageAgent, msgHistory, {
      stream: true,
    });
    stream
      .toTextStream({
        compatibleWithNodeStreams: true,
      })
      .pipe(process.stdout);
    await stream.completed
    const newMsgHistory = stream.history;
    for (let i = msgHistory.length; i < newMsgHistory.length; i++) {
      const msg = newMsgHistory[i];
      const msgID = `${Date.now() - parseInt(currentChat.id)}${i}`;
      await chatMessages.put(msgID, { prevID: currentChat.msgID, item: msg });
      process.stdout.write(stringify(msg));
      currentChat.msgID = msgID
    }
    await chats.put("current", currentChat);
  }
}

main().catch((err) => {
  if (err instanceof AgentsError && err.state) {
    console.log(err.state);
    console.error(JSON.stringify(err.state));
  } else {
    console.error(err);
  }
});
