import { Agent, AgentInputItem, run } from "@openai/agents";

import { JSONLAppender, replayJSONL } from "./io-combinators.ts";

import { createProxyStore, DictStore, ProxyStore, RelativeStore, Store } from "./storage-combinators.ts";
import { stringifyYaml } from "./util.ts";
import { urlToHttpOptions } from "node:url";

export type Message = AgentInputItem;

// eg it points to maxMsgIndex in chats, starts with 0
// if no 0 message, means empty convo
export type Chat = number;


export type ModelOptions = {
    filename: string;
    agents: Agent[];
    listener?: (source: Store<Message>) => Store<Message>;
    USE_TRACE?: boolean;
    USE_OPENROUTER?: boolean;
};

export class Chats extends ProxyStore<Chat> {
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

export class ChatModel {
    public agents: Agent[] = [];

    constructor(public chats: Chats, private allMessages: Store<Message>, public options: ModelOptions) { }

    async get(chatId?: string): Promise<Message[]> {
        const currentChatId = chatId ?? await this.chats.current();
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

    async nextMsgIndex(chatId: string): Promise<number> {
        const currentMessages = await this.messageStore(chatId);
        let maxMsgIndex = await this.chats.getMaxMsgIndex(chatId);
        // chat with maxMsgIndex 0 can point to an empty chat or to a deleted message
        // so check if message exists at that index 
        const slotOccupied = !!await currentMessages.get(maxMsgIndex.toString());
        if (slotOccupied) {
            maxMsgIndex++;
        }
        return maxMsgIndex;
    }

    async appendMessages(messages: Message[], chatId?: string): Promise<void> {
        if (messages.length === 0) {
            return;
        }
        const currentChatId = chatId ?? await this.chats.current();
        const currentMessages = await this.messageStore(currentChatId);
        let maxMsgIndex = await this.nextMsgIndex(currentChatId);
        for (const msg of messages) {
            await currentMessages.put(maxMsgIndex.toString(), msg);
            await this.chats.put(currentChatId, maxMsgIndex);
            maxMsgIndex++;
        }
    }

    async messageStore(chatId: string): Promise<Store<Message>> {
        return await new RelativeStore<Message>(this.allMessages, chatId);
    }

    async deleteLastMessage(chatId?: string): Promise<Message | null> {
        const currentChatId = chatId ?? await this.chats.current();
        let maxMsgIndex = await this.chats.getMaxMsgIndex(currentChatId);
        const msgIdKey = maxMsgIndex.toString();
        const currentMessages = await this.messageStore(currentChatId);
        const ret = await currentMessages.get(msgIdKey);
        await currentMessages.delete(msgIdKey);
        maxMsgIndex = Math.max(0, maxMsgIndex - 1);
        await this.chats.put(currentChatId, maxMsgIndex);
        return ret
    }

    async *llm(currentAgent: Agent, chatId?: string): AsyncGenerator<string> {
        let msgsBeforeAI = await this.get(chatId);
        msgsBeforeAI = msgsBeforeAI.filter((msg) => !(this.options.USE_OPENROUTER && msg.type === "hosted_tool_call"));
        const stream = await run(currentAgent, msgsBeforeAI, {
            stream: true,
        });
        let historyLength = msgsBeforeAI.length;
        for await (const event of stream) {
            if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
                yield event.data.delta;
            } else {
                // TODO: Listen to events for more advanced features.
                // - Search/Citations:
                //   - `response.output_item.added` with `web_search_call`
                //   - `response.web_search_call.searching`
                //   - `response.output_item.done` with `web_search_call` (contains query)
                //   - `tool_called` for `web_search_call`
                //   - Citations may appear in `annotations` of `output_text` parts.
                // - Better message detection:
                //   - `response.output_item.done` with `item.type: 'message'` signals a complete message from the AI.
                //     This is more direct than waiting for `stream.history` to update.
                // - Storing full API responses:
                //   - The `response_done` event contains the final `response` object, which can be stored.
                if (this.options.USE_TRACE) {
                    console.log(stringifyYaml({ "event": event }));
                }
            }
            if (historyLength < stream.history.length) {
                const newMessages = stream.history.slice(historyLength);
                historyLength += newMessages.length;
                await this.appendMessages(newMessages, chatId);
            }
        }
        await stream.completed;
        const newMessages = stream.history.slice(historyLength);
        // shouldn't have new messages here cos they should all appear during streaming
        await this.appendMessages(newMessages, chatId);
        if (this.options.USE_TRACE) {
            console.log("rawResponses\n", stringifyYaml(stream.rawResponses));
        }
    }

    static async init(options: ModelOptions) {
        const { filename, agents, listener } = options;
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
        const allMessages = listener ? listener(messagesStore) : messagesStore;

        const ret = new ChatModel(chats, allMessages, options);
        ret.agents = agents;
        return ret;
    }
}
