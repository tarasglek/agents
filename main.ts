import { Hono } from "hono";
import { html, raw } from "hono/html";
import { stream, streamText } from "hono/streaming";
import { initAgents } from "./agents.ts";
import { ChatModel, Message } from "./model.ts";
import { createProxyStore, Store } from "./storage-combinators.ts";
import { stringifyYaml } from "./util.ts";
const messagePrinterWrapper = (source: Store<Message>) =>
  createProxyStore(source, {
    async put(superPut, ref, data) {
      await console.log("\n" + JSON.stringify([data]) + "\n");
      return superPut(ref, data);
    },
  });

let modelPromise: Promise<ChatModel> | null = null;
function getModel(): Promise<ChatModel> {
  if (modelPromise) {
    return modelPromise;
  }
  modelPromise = (async () => {
    const agents = await initAgents({
      USE_OPENROUTER: !!Deno.env.get("OPENROUTER_API_KEY"),
      USE_TRACE: false,
    });
    return await ChatModel.init(
      "history.jsonl",
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

    for (const [i, msg] of (await model.get()).entries()) {
      await stream.write(await (html`
              <p id="${i}">
                <pre>${stringifyYaml([msg])}</pre>
              </p>
            `).toString());
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
  const userInput = await c.req.parseBody();
  // reject File for now
  if (!(userInput instanceof string)) {
    return c.text("File input is not supported yet", 400);
  }
  const model = await getModel();

  const msg = {
    type: "message",
    role: "user",
    content: userInput.trim(),
  } as AgentInputItem;
  await model.appendMessages([msg]);
  console.log(body["input"]);
  return c.redirect(`/${currentChatId}`);
});

export default app;
