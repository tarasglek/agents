import { Agent, AgentsError, run } from "@openai/agents";
import { stringify } from "jsr:@std/yaml";
import { OpenAI } from "openai";
import { setDefaultOpenAIClient } from "@openai/agents";
import {
  fetchProxyCurlLogger,
  prettyJsonLogger,
} from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from '@openai/agents';
import { DictStore, Store } from "./storage-combinators.ts";
import { open } from "node:fs";

setOpenAIAPI('chat_completions');

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

const chatHistory = new DictStore<string>();

const configDir = "."

function replayJSONL<T>(src: string, dest: Store<T>) {
  for each line in open(src) {
    const { key, operation, value } = line
    if(operation === "delete") {
    dest.delete(key);
  } ....
}

async function main() {
  const customClient = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: Deno.env.get(
      "OPENROUTER_API_KEY",
    ),
    fetch: fetchWithPrettyJson as any
  });
  setDefaultOpenAIClient(customClient as any);
  const stream = await run(triageAgent, "What is the capital of France?", {
    stream: true,
  });
  // const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
  // textStream.pipe(process.stdout);
  for await (const event of stream) {
    // these are the raw events from the model
    if (event) {
      let text: string = "";
      try {
        text = stringify(event)
      } catch (_e) {
        text = JSON.stringify(event)
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
    console.error(JSON.stringify(err.state))
  } else {
    console.error(err)
  }
});
