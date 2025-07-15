import { Hono } from "hono";
import { stream, StreamingApi } from "hono/streaming";
import { initAgents } from "./agents.ts";
import { ChatModel, Message, ModelOptions } from "./model.ts";
import { createProxyStore, Store } from "./storage-combinators.ts";
import { Agent, AgentInputItem } from "@openai/agents-core";
import { serveDir } from "@std/http/file-server";
import {
  renderHeader,
  renderMessage,
  streamAIResponse,
} from "./template/chat/chat.ts";

const messagePrinterWrapper = (source: Store<Message>) =>
  createProxyStore(source, {
    async put(superPut, ref, data) {
      await console.log("\n" + JSON.stringify([data]) + "\n");
      return superPut(ref, data);
    },
  });

const modelOptions: Omit<ModelOptions, "agents"> = {
  USE_OPENROUTER: !!Deno.env.get("OPENROUTER_API_KEY"),
  USE_TRACE: false,
  filename: "data/history.jsonl",
  listener: messagePrinterWrapper,
};

let agentsPromise: Promise<Agent[]> | null = null;
function getAgents(): Promise<Agent[]> {
  if (agentsPromise) {
    return agentsPromise;
  }
  agentsPromise = initAgents(modelOptions);
  return agentsPromise;
}

let modelPromise: Promise<ChatModel> | null = null;
function getModel(): Promise<ChatModel> {
  if (modelPromise) {
    return modelPromise;
  }
  modelPromise = (async () => {
    const agents = await getAgents();
    return await ChatModel.init({ ...modelOptions, agents });
  })();
  return modelPromise;
}

const app = new Hono();

app.post("/new-chat", async (c) => {
  const model = await getModel();
  const newChatId = await model.chats.newChat();
  return c.redirect(`/chat/${newChatId}`);
});

app.get("/chat/:currentChatId", (c) => {
  const { currentChatId } = c.req.param();
  c.header("Content-Type", "text/html; charset=utf-8");
  return stream(c, async (stream) => {
    await stream.write(renderHeader(currentChatId));

    const model = await getModel();
    const agents = await getAgents();

    let lastMsg: Message | null = null;
    const oldMessages = await model.get(currentChatId);
    for (const [i, msg] of oldMessages.entries()) {
      await stream.write(await renderMessage(msg, i));
      lastMsg = msg;
    }
    if (lastMsg?.type === "message" && lastMsg.role === "user") {
      await streamAIResponse(stream, model, currentChatId, oldMessages, agents);
    }
    await stream.write(footerTmpl);
  });
});

app.get("/", async (c) => {
  const model = await getModel();
  return c.redirect(`/chat/${await model.chats.current()}`);
});

app.post("/chat/:currentChatId", async (c) => {
  const { currentChatId } = c.req.param();
  const body = await c.req.parseBody();
  let userInput = (body as Record<string, string | File>)["input"];
  // reject File for now
  if (typeof userInput !== "string") {
    return c.text("File input is not supported yet", 400);
  }
  userInput = userInput.trim();
  if (userInput.length === 0) {
    return c.text("Input cannot be empty", 400);
  }
  const model = await getModel();

  const msg = {
    type: "message",
    role: "user",
    content: userInput.trim(),
  } as AgentInputItem;
  await model.appendMessages([msg], currentChatId);
  return c.redirect(
    `/chat/${currentChatId}#${(await model.get(currentChatId)).length}`,
  );
});

app.use("/static/*", async (c) => {
  const serveOptions = {
    urlRoot: "static",
    fsRoot: "static",
    headers: [
      "Cache-Control: no-cache, no-store, must-revalidate",
      "Pragma: no-cache",
      "Expires: 0",
    ],
  };

  if (c.req.method === "HEAD") {
    // serveDir doesn't support HEAD, so we fake it by calling with GET and discarding the body
    const getReq = new Request(c.req.url, {
      method: "GET",
      headers: c.req.raw.headers,
    });
    const res = await serveDir(getReq, serveOptions);
    // We don't need the body, so we can cancel it to free up resources.
    await res.body?.cancel();
    return new Response(null, {
      headers: res.headers,
      status: res.status,
      statusText: res.statusText,
    });
  }

  return serveDir(c.req.raw, serveOptions);
});

export default app;
