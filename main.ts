import { Hono } from "hono";
import { html, raw } from "hono/html";
import { initAgents } from "./agents.ts";
import { ChatModel, Message } from "./model.ts";
import { createProxyStore, Store } from "./storage-combinators.ts";
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
    <label for="comments">Comments</label>
    <textarea id="comments"></textarea>
  </form>
`;
app.get("/", async (c) => {
  return c.redirect(`/${await model.chats.current()}`);
});

app.get("/:currentChatId", (c) => {
  const { currentChatId } = c.req.param();
  return c.html(
    html`
      <!DOCTYPE html>
      <h1>Hello! ${currentChatId} ${JSON.stringify(c.req.raw.headers)}!</h1>
      <pre>
        </pre>
      <br>
      ${chatInput}
    `,
  );
});

export default app;
