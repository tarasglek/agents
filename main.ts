import { Hono } from "hono";
import { html, raw } from "hono/html";
import { streamText } from "hono/streaming";
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

const agents = await initAgents({
  USE_OPENROUTER: !!Deno.env.get("OPENROUTER_API_KEY"),
  USE_TRACE: false,
});
const model = await ChatModel.init(
  "history.jsonl",
  agents,
  messagePrinterWrapper,
);

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
  <form>
    <label for="input">User</label>
    <textarea id="input"></textarea>
  </form>
`;
app.get("/", async (c) => {
  return c.redirect(`/${await model.chats.current()}`);
});

app.get("/stream", (c) => {
  return streamText(c, async (stream) => {
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

app.get("/:currentChatId", async (c) => {
  const { currentChatId } = c.req.param();
  return c.html(
    html`
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="icon" href="https://fav.farm/🤖" />
          <title>Agents ${currentChatId}</title>
        </head>
        <body>
          ${(await model.get()).map((msg) => {
            return html`
              <p>
                <pre>${stringifyYaml([msg])}</pre>
              </p>
            `;
          })} ${chatInput}
        </body>
      </html>
    `,
  );
});

export default app;
