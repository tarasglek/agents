// deno-lint-ignore-file no-process-global
import { Agent, AgentInputItem } from "@openai/agents";

import { parseArgs } from "jsr:@std/cli/parse-args";

import { createProxyStore, Store } from "./storage-combinators.ts";
import { initAgents } from "./agents.ts";
import { ChatModel, Message, ModelOptions } from "./model.ts";
import { stringifyYaml } from "./util.ts";


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

/**
 * THis is written stupidly cos ai wrote it to serve as a demo of switching agents and deleting messages
 */
async function handleCommand(userInput: string, currentAgent: Agent, model: ChatModel): Promise<Agent> {
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
      model.agents.forEach((agent, i) => {
        console.log(`${i}: ${agent.name}`);
      });
      console.log(`Current agent is: ${currentAgent.name}`);
    } else {
      const agentIndex = parseInt(args[0], 10);
      if (
        !isNaN(agentIndex) && agentIndex >= 0 && agentIndex < model.agents.length
      ) {
        currentAgent = model.agents[agentIndex];
        console.log(`Switched to agent: ${currentAgent.name}`);
      } else {
        console.log("Invalid agent number.");
      }
    }
  } else if (command === "del-last-msg") {
    const deletedMsg = await model.deleteLastMessage();
    if (deletedMsg) {
      console.log("Deleted last message:");
      console.log(stringifyYaml(deletedMsg));
      console.log("New history:");
      console.log(stringifyYaml(await model.get()));
    } else {
      console.log("No message to delete.");
    }
  } else if (command === "clear") {
    const chatId = await model.chats.newChat();
    console.log(`New chat (id:${chatId}) started.`);
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

const messagePrinterWrapper = (source: Store<Message>) =>
  createProxyStore(source, {
    async put(superPut, ref, data) {
      await process.stdout.write("\n" + stringifyYaml([data]) + "\n");
      return superPut(ref, data);
    },
  });

async function main() {
  const options: Omit<ModelOptions, "agents"> = {
    USE_OPENROUTER,
    USE_TRACE,
    model: flags.model,
    filename: "data/history.jsonl",
    listener: messagePrinterWrapper,
  };
  const agents = await initAgents(options);
  const model = await ChatModel.init({ ...options, agents });

  let currentAgent = agents.at(-1)!;

  console.log(stringifyYaml(await model.get()));

  while (true) {
    const userInput = prompt(getPrompt(currentAgent));
    if (userInput === null) { // EOF
      break;
    }
    if (userInput.startsWith("/")) {
      currentAgent = await handleCommand(userInput, currentAgent, model);
    } else if (userInput) {
      const msg = {
        type: "message",
        role: "user",
        content: userInput.trim(),
      } as AgentInputItem;
      await model.appendMessages([msg]);

      try {
        for await (const delta of model.llm(currentAgent)) {
          await process.stdout.write(delta);
        }
        await process.stdout.write("\n");
      } catch (error) {
        console.error("\nAn error occurred:", error.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
});
