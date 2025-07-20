import { Hono } from "hono";
import { stream } from "hono/streaming";
import { initAgents } from "./agents.ts";
import { ChatModel, Message, ModelOptions } from "./model.ts";
import { createProxyStore, Store } from "./storage-combinators.ts";
import { Agent, AgentInputItem } from "@openai/agents-core";
import { serveDir } from "@std/http/file-server";
import { encode } from "@std/encoding/base64";
import * as chat from "./template/chat/chat.ts";

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
    await stream.write(chat.renderHeader(currentChatId));

    const model = await getModel();
    const agents = await getAgents();

    let lastMsg: Message | null = null;
    const oldMessages = await model.get(currentChatId);
    for (const [i, msg] of oldMessages.entries()) {
      await stream.write(await chat.renderMessage(msg, i));
      lastMsg = msg;
    }
    if (lastMsg?.type === "message" && lastMsg.role === "user") {
      await chat.streamAIResponse(stream, model, currentChatId, oldMessages, agents);
    }
    await stream.write(chat.footer);
  });
});

app.get("/", async (c) => {
  const model = await getModel();
  return c.redirect(`/chat/${await model.chats.current()}`);
});

app.post("/chat/:currentChatId", async (c) => {
  const { currentChatId } = c.req.param();
  const rawBody = await c.req.parseBody();
  console.log("Form data received:", rawBody);

  const body: Record<string, string | File> = {};
  for (const key in rawBody) {
    const value = rawBody[key];
    if (value instanceof File) {
      if (value.size > 0) {
        body[key] = value;
      }
    } else if (typeof value === "string") {
      if (value.trim().length > 0) {
        body[key] = value;
      }
    }
  }

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return c.text("Input cannot be empty", 400);
  }

  type ContentPart = {
    type: "input_text";
    text: string;
  } | {
    type: "input_file";
    file: string;
  };
  let content: string | ContentPart[];

  if (keys.length === 1 && keys[0] === "input" && typeof body.input === "string") {
    content = (body.input as string).trim();
  } else {
    const contentParts: ContentPart[] = [];
    for (const key in body) {
      const value = body[key];
      if (typeof value === "string") {
        contentParts.push({ type: "input_text", text: value.trim() });
      } else if (value instanceof File) {
        const arrayBuffer = await value.arrayBuffer();
        const base64 = encode(arrayBuffer);
        const dataUrl = `data:${value.type};base64,${base64}`;
        contentParts.push({ type: "input_file", file: dataUrl });
      }
    }
    content = contentParts;
  }

  const model = await getModel();

  const msg = {
    type: "message",
    role: "user",
    content: content,
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
