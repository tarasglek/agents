import { Hono } from "hono";
import { html, raw } from "hono/html";
import { stream, streamText } from "hono/streaming";
import { initAgents } from "./agents.ts";
import { ChatModel, Message } from "./model.ts";
import { createProxyStore, Store } from "./storage-combinators.ts";
import { stringifyYaml } from "./util.ts";
import { Agent, AgentInputItem, user } from "@openai/agents-core";
const messagePrinterWrapper = (source: Store<Message>) =>
  createProxyStore(source, {
    async put(superPut, ref, data) {
      await console.log("\n" + JSON.stringify([data]) + "\n");
      return superPut(ref, data);
    },
  });

let agentsPromise: Promise<Agent[]> | null = null;
function getAgents(): Promise<Agent[]> {
  if (agentsPromise) {
    return agentsPromise;
  }
  agentsPromise = initAgents({
    USE_OPENROUTER: !!Deno.env.get("OPENROUTER_API_KEY"),
    USE_TRACE: false,
  });
  return agentsPromise;
}

let modelPromise: Promise<ChatModel> | null = null;
function getModel(): Promise<ChatModel> {
  if (modelPromise) {
    return modelPromise;
  }
  modelPromise = (async () => {
    const agents = await getAgents();
    return await ChatModel.init(
      "data/history.jsonl",
      agents,
      messagePrinterWrapper,
    );
  })();
  return modelPromise;
}

const app = new Hono();
const chatInput = html`
  <style>
  form {
    width: 20rem;
    display: flex;
    flex-direction: column;
  }

  textarea {
    field-sizing: content;
  }
  </style>
  <form method="POST" action="">
    <label for="input">User</label>
    <textarea id="input" name="input"></textarea>
    <button type="submit">Send</button>
  </form>
`;
app.get("/", async (c) => {
  const model = await getModel();
  return c.redirect(`/${await model.chats.current()}`);
});

app.get("/stream", (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  return stream(c, async (stream) => {
    // Send initial HTML shell
    await stream.write(`<!DOCTYPE html><html><body>`);
    await stream.writeln(`<h1>Start Streaming</h1>`);

    // Simulate a delayed fetch (e.g. DB/API)
    await stream.sleep(500);
    await stream.writeln(`<p>Step 1 completed</p>`);

    await stream.sleep(500);
    await stream.writeln(`<p>Step 2 completed</p>`);

    await stream.sleep(500);
    await stream.writeln(`<p>All done!</p>`);

    // Close HTML
    await stream.write(`</body></html>`);
  });
});

app.get("/:currentChatId", (c) => {
  const { currentChatId } = c.req.param();
  c.header('Content-Type', 'text/html; charset=utf-8');
  return stream(c, async (stream) => {
    await stream.write(await (html`
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="icon" href="https://fav.farm/🤖" />
          <title>Agents ${currentChatId}</title>
        </head>
        <body>`).toString());

    const model = await getModel();

    let lastMsg: Message | null = null;
    for (const [i, msg] of (await model.get()).entries()) {
      await stream.write(await (html`
              <p id="${i}">
                <pre>${stringifyYaml([msg])}</pre>
              </p>
            `).toString());
      lastMsg = msg;
    }
    if (lastMsg?.type === 'message' && lastMsg.role === 'user') {
      // make me a lazy func for agents too
      const agents = await getAgents();
      /*do not await*/ model.llm(agents[0]);
      let oldWipMsg = '';
      // so that the screen doesn't jump around
      // 50vh = 50% of viewport height
      await stream.write(html`<p id=${(await model.get()).length} style="min-height: 50vh;"><pre>`.toString())
      while (model.wipMsg !== null) {
        if (oldWipMsg === model.wipMsg) {
          await stream.sleep(1000 / 60); // 60 FPS
          continue; // wait for new message
        }
        const newChunk = model.wipMsg.slice(oldWipMsg.length);
        await stream.write(html`${newChunk}`.toString());
        oldWipMsg = model.wipMsg;
      }
      await stream.write(html`</pre></p>`.toString());
    }
    await stream.write(await (chatInput.toString()));
    await stream.write(await (html`
        </body>
        </html>
          `.toString()));
  });
});

app.post("/:currentChatId", async (c) => {
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
  await model.appendMessages([msg]);
  return c.redirect(`/${currentChatId}#${(await model.get()).length - 1}`);
});

export default app;
