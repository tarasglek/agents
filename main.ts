import { Hono } from "hono";
import { html } from "hono/html";
import { stream, StreamingApi } from "hono/streaming";
import { initAgents } from "./agents.ts";
import { ChatModel, Message, ModelOptions } from "./model.ts";
import { createProxyStore, Store } from "./storage-combinators.ts";
import { stringifyYaml } from "./util.ts";
import { Agent, AgentInputItem, AssistantMessageItem } from "@openai/agents-core";
import { serveDir } from "@std/http/file-server";

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

async function* wordWrap(stream: AsyncIterable<string>, maxWidth: number): AsyncGenerator<string> {
  let currentLineLength = 0;
  for await (const delta of stream) {
    let newDelta = '';
    for (const char of delta) {
      if (char === '\n') {
        newDelta += char;
        currentLineLength = 0;
      } else {
        if (currentLineLength >= maxWidth) {
          newDelta += '\n';
          currentLineLength = 0;
        }
        newDelta += char;
        currentLineLength++;
      }
    }
    yield newDelta;
  }
}

async function streamAIResponse(
  stream: StreamingApi,
  model: ChatModel,
  currentChatId: string,
  oldMessages: Message[],
) {
  const agents = await getAgents();
  //append to text
  try {
    const llmStream = model.llm(agents[agents.length - 1], currentChatId);

    // Trick to scroll to the new message as it streams:
    // An anchor tag with `autofocus` will be scrolled into view by the browser.
    // `tabindex="-1"` makes the anchor focusable without being in the tab order.
    // The `min-height: 90vh` (90% of viewport height) on the <pre> prevents the
    // layout from jumping around as the content streams in.
    await stream.write(html`<div id="msgWip"><a name="${(await model.get(currentChatId)).length}" tabindex="-1" autofocus></a><pre  style="min-height: 90vh;">`.toString())
    const MAX_WIDTH = 80;
    for await (const delta of wordWrap(llmStream, MAX_WIDTH)) {
      await stream.write(html`${delta}`.toString());
    }
    await stream.write("\n" + html`</pre></div>`.toString());
    // emit some css to hide the wip message completely
    await stream.write(html`<style>#msgWip { display: none;  }</style>`.toString());
    // Now we can safely append the completed messages
    const completedMessages = (await model.get(currentChatId)).slice(oldMessages.length);
    for (const [i, msg] of completedMessages.entries()) {
      await stream.write(await (html`
          <div>
            <a name="${i + oldMessages.length}"></a>
            <pre>${stringifyYaml([msg])}</pre>
    </div>
        `).toString());
    }
  } catch (e) {
    console.error(e);
    await stream.write(html`<div class="error"><pre>${e.message}</pre></div>`.toString());
  }
}

const app = new Hono();
const chatInput = html`
  <form method="POST" action="">
    <label for="input">User</label>
    <div style="display: flex; align-items: flex-end; gap: 0.5rem;">
      <textarea id="input" name="input" style="flex: 1;"></textarea>
      <button type="submit" style="flex-shrink: 0; width: 4rem; height: 4rem; padding: 1rem;">Send</button>
    </div>
  </form>
`;

const newChatButton = html`
  <form method="POST" action="/new-chat">
    <button type="submit">New Chat</button>
  </form>
`;

app.post("/new-chat", async (c) => {
  const model = await getModel();
  const newChatId = await model.chats.newChat();
  return c.redirect(`/chat/${newChatId}`);
});

app.get("/chat/:currentChatId", (c) => {
  const { currentChatId } = c.req.param();
  c.header('Content-Type', 'text/html; charset=utf-8');
  return stream(c, async (stream) => {
    await stream.write(await (html`
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
          <link rel="icon" href="https://fav.farm/🤖" />
          <title>Agents ${currentChatId}</title>
        </head>
        <body>
          <main class="container">`).toString());

    const model = await getModel();

    let lastMsg: Message | null = null;
    const oldMessages = await model.get(currentChatId)
    for (const [i, msg] of (oldMessages).entries()) {
      await stream.write(await (html`
              <div>
                <a name="${i}"></a>
                <pre>${stringifyYaml([msg])}</pre>
      </div>
            `).toString());
      lastMsg = msg;
    }
    if (lastMsg?.type === 'message' && lastMsg.role === 'user') {
      await streamAIResponse(stream, model, currentChatId, oldMessages);
    }
    await stream.write(await (chatInput.toString()));
    await stream.write(newChatButton.toString());

    await stream.write(await (html`
          </main>
        </body>
        </html>
          `.toString()));
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
  return c.redirect(`/chat/${currentChatId}#${(await model.get(currentChatId)).length}`);
});


app.use('/static/*', async (c) => {
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
    const getReq = new Request(c.req.url, { method: "GET", headers: c.req.headers });
    const res = await serveDir(getReq, serveOptions);
    // We don't need the body, so we can cancel it to free up resources.
    await res.body?.cancel();
    return new Response(null, { headers: res.headers, status: res.status, statusText: res.statusText });
  }

  return serveDir(c.req.raw, serveOptions);
});

export default app;
