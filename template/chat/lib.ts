import { html } from "hono/html";
import { StreamingApi } from "hono/streaming";
import { Agent } from "@openai/agents-core";
import { ChatModel, Message } from "../../model.ts";
import { stringifyYaml } from "../../util.ts";

export async function* wordWrap(stream: AsyncIterable<string>, maxWidth: number): AsyncGenerator<string> {
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

export async function streamAIResponse(
  stream: StreamingApi,
  model: ChatModel,
  currentChatId: string,
  oldMessages: Message[],
  agents: Agent[],
) {
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
      await stream.write(await renderMessage(msg, i + oldMessages.length));
    }
  } catch (e) {
    console.error(e);
    await stream.write(html`<div class="error"><pre>${e.message}</pre></div>`.toString());
  }
}

export function renderHeader(currentChatId: string): string {
  return html`<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
    <link rel="icon" href="https://fav.farm/🤖" />
    <title>Agents ${currentChatId}</title>
  </head>
  <body>
    <main class="container">`.toString();
}

export function renderFooter(): string {
  return html`
<form method="POST" action="">
  <label for="input">User</label>
  <div style="display: flex; align-items: flex-end; gap: 0.5rem">
    <textarea id="input" name="input" style="flex: 1"></textarea>
    <button
      type="submit"
      style="flex-shrink: 0; width: 4rem; height: 4rem; padding: 1rem"
    >
      Send
    </button>
  </div>
</form>
<form method="POST" action="/new-chat">
  <button type="submit">New Chat</button>
</form>
</main>
</body>
</html>`.toString();
}

export async function renderMessage(msg: Message, index: number): Promise<string> {
  return (await html`
          <div>
            <a name="${index}"></a>
            <pre>${stringifyYaml([msg])}</pre>
    </div>
        `).toString();
}
