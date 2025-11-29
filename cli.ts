// deno-lint-ignore-file no-process-global
import { Agent, AgentInputItem } from "@openai/agents";
import { encodeBase64 } from "@std/encoding/base64";
import { contentType } from "jsr:@std/media-types/content-type";
import { extname } from "jsr:@std/path/extname";

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
  --provider <name>  Specify the provider (e.g., 'openai', 'openrouter'). Defaults to 'openrouter'.
  --model <name>     Specify the model to use.
  --trace            Enable tracing of API requests.
  --help, -h         Show this help message.

Commands within the chat:
  /help              Show in-chat command help.
  /agent             List or switch agents.
  /del-last-msg      Delete the last message.
  /clear             Start a new chat.
  /submit            Submit chat history as is.
  /quit              Exit the application.
  `);
  Deno.exit(0);
}

const provider = flags.provider ?? "openrouter";
const USE_OPENROUTER = provider === "openrouter";
const USE_TRACE = flags.trace ?? false;

function getAudioDetails(
  filename: string,
  mimeType: string,
): { isAudio: boolean; format: string } {
  const ext = extname(filename).slice(1).toLowerCase();

  if (ext === "mp3" || mimeType === "audio/mpeg") {
    return { isAudio: true, format: "mp3" };
  }
  if (ext === "wav" || mimeType === "audio/wav") {
    return { isAudio: true, format: "wav" };
  }

  return { isAudio: false, format: "" };
}

/**
 * THis is written stupidly cos ai wrote it to serve as a demo of switching agents and deleting messages
 */
async function handleCommand(
  userInput: string,
  currentAgent: Agent,
  model: ChatModel,
): Promise<Agent> {
  const [command, ...args] = userInput.slice(1).split(" ");
  if (command === "help") {
    console.log("Available commands:");
    console.log("/help - Show this help message");
    console.log("/agent - List available agents");
    console.log("/agent <number> - Select an agent");
    console.log("/del-last-msg - Delete the last message");
    console.log("/clear - Start a new chat");
    console.log("/submit - Submit chat history as is");
    console.log("/attach <filename> - Attach a file to the conversation.");
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
        !isNaN(agentIndex) && agentIndex >= 0 &&
        agentIndex < model.agents.length
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
  } else if (command === "submit") {
    try {
      for await (const delta of model.llm(currentAgent)) {
        await process.stdout.write(delta);
      }
      await process.stdout.write("\n");
    } catch (error) {
      console.error("\nAn error occurred:", error.message);
    }
  } else if (command === "attach") {
    const filename = args.join(" ");
    if (!filename) {
      console.log("Usage: /attach <filename>");
    } else {
      try {
        const fileContent = await Deno.readFile(filename);
        const mimeType = contentType(filename) ?? "application/octet-stream";
        const { isAudio, format } = getAudioDetails(filename, mimeType);

        if (!isAudio) {
          console.log(
            `Unsupported file type: ${
              extname(filename)
            }. Only mp3 and wav are supported.`,
          );
          return currentAgent;
        }

        const base64 = encodeBase64(fileContent);
        const dataUrl = `data:${mimeType};base64,${base64}`;
        const msg: AgentInputItem = {
          type: "message",
          role: "user",
          content: [
            {
              type: "audio",
              audio: dataUrl,
              format: format,
            },
          ],
        };
        await model.appendMessages([msg]);
        console.log(`Attached file: ${filename}`);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          console.error(`File not found: ${filename}`);
        } else {
          console.error(`Error attaching file: ${error.message}`);
        }
      }
    }
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
  const modelOpts: Omit<ModelOptions, "agents"> = {
    USE_OPENROUTER,
    USE_TRACE,
    filename: "data/history.jsonl",
    listener: messagePrinterWrapper,
  };
  const agents = await initAgents({ ...modelOpts, model: flags.model });
  const model = await ChatModel.init({ ...modelOpts, agents });

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
