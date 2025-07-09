// deno-lint-ignore-file no-process-global
import { Agent, AgentInputItem, run } from "@openai/agents";

import { stringify } from "jsr:@std/yaml";
import { parseArgs } from "jsr:@std/cli/parse-args";
import { JSONLAppender, replayJSONL } from "./io-combinators.ts";

import { createProxyStore, DictStore, ProxyStore, RelativeStore, Store } from "./storage-combinators.ts";
import { initAgents } from "./agents.ts";


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

type Message = AgentInputItem;

// eg it points to maxMsgIndex in chats, starts with 0
// if no 0 message, means empty convo
type Chat = number;


class Chats extends ProxyStore<Chat> {
  private currentChatId: undefined | string = undefined;

  constructor(private chats: Store<Chat>) {
    super(chats);
  }

  async put(chatId: string, data: Chat): Promise<void> {
    await super.put(chatId, data);
    this.currentChatId = chatId; // set current chat id to the first one we put
  }

  async current(): Promise<string> {
    return this.currentChatId !== undefined ? this.currentChatId : await this.newChat();
  }

  async getMaxMsgIndex(chatId: string): Promise<number> {
    return (await this.get(chatId)) ?? 0;
  }

  async newChat() {
    let uid = Date.now();
    while (await this.chats.get(uid.toString())) {
      uid += 1; // ensure unique id
    }
    // we could use something like uuidv7 here, but timestamps that occasionally drift into the future are fine for our purposes
    const newChatId = `${uid}`;
    await this.put(newChatId, 0);
    return newChatId;
  }
}

class ChatModel {
  public agents: Agent[] = [];
  constructor(public chats: Chats, private allMessages: Store<Message>) { }

  async get(): Promise<Message[]> {
    const currentChatId = await this.chats.current();
    const maxMsgIndex = (await this.chats.getMaxMsgIndex(currentChatId));
    const currentMessages = await this.messageStore(currentChatId);
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
    const currentChatId = await this.chats.current();
    const currentMessages = await this.messageStore(currentChatId);
    let maxMsgIndex = await this.chats.getMaxMsgIndex(currentChatId);
    // chat with maxMsgIndex 0 can point to an empty chat or to a deleted message
    // so check if message exists at that index 
    const slotOccupied = !!await currentMessages.get(maxMsgIndex.toString());
    if (slotOccupied) {
      maxMsgIndex++;
    }
    for (const msg of messages) {
      await currentMessages.put(maxMsgIndex.toString(), msg);
      await this.chats.put(currentChatId, maxMsgIndex);
    }
  }

  async messageStore(chatId: string): Promise<Store<Message>> {
    return await new RelativeStore<Message>(this.allMessages, chatId);
  }

  async deleteLastMessage(): Promise<Message | null> {
    const currentChatId = await this.chats.current();
    let maxMsgIndex = await this.chats.getMaxMsgIndex(currentChatId);
    const msgIdKey = maxMsgIndex.toString();
    const currentMessages = await this.messageStore(currentChatId);
    const ret = await currentMessages.get(msgIdKey);
    await currentMessages.delete(msgIdKey);
    maxMsgIndex = Math.max(0, maxMsgIndex - 1);
    await this.chats.put(currentChatId, maxMsgIndex);
    return ret
  }

  static async init(filename: string, agents: Agent[], listener: (source: Store<Message>) => Store<Message>) {
    const memoryStore = new DictStore<Message>();
    const chatsStore = new DictStore<Chat>();
    const chats = new Chats(chatsStore);

    // make a proxy store for memoryStore so we can look at keys as we replaying messages
    // and populate chatsStore with chatId= Math.max(old,new maxMsgIndex)
    const replayProxy = createProxyStore(memoryStore, {
      async put(superPut, ref, data) {
        const parts = ref.split("/");
        if (parts[0] === "messages" && parts.length === 3) {

          const chatId = parts[1];
          const msgIndex = parseInt(parts[2], 10);
          if (!isNaN(msgIndex)) {
            const currentMax = (await chats.getMaxMsgIndex(chatId));
            if (msgIndex > currentMax) {
              await chats.put(chatId, msgIndex);
            }
          }
        }
        return superPut(ref, data);
      },
    });
    await replayJSONL(filename, replayProxy);
    // appender ensures everything we add to memoryStore is also written to disk
    // we replayJSONL it above ^
    const diskStore = new JSONLAppender(filename, memoryStore);
    // putting messages into a relative store with prefix "messages"
    // so in future we can put more stuff like "agents" in there, etc
    const messagesStore = new RelativeStore<Message>(diskStore as unknown as Store<Message>, "messages");
    const allMessages = listener(messagesStore);

    const ret = new ChatModel(chats, allMessages);
    ret.agents = agents;
    return ret;
  }
}

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
  const agents = await initAgents({ USE_OPENROUTER, USE_TRACE, model: flags.model });
  const model = await ChatModel.init("history.jsonl", agents, messagePrinterWrapper);

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

      await model.llm();
    }
  }
}

main().catch((err) => {
  console.error(err);
});
