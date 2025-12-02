import {
  Agent,
  MCPServerStdio,
  setTracingDisabled,
  tool,
  webSearchTool,
} from "@openai/agents";
import { ModelOptions } from "./model.ts";
import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";

import { ClientOptions, OpenAI } from "openai";
import { z } from "zod";
import { setDefaultOpenAIClient } from "@openai/agents";
import {
  fetchProxyCurlLogger,
  prettyJsonLogger,
} from "@tarasglek/fetch-proxy-curl-logger";

import { setOpenAIAPI } from "@openai/agents";

export async function initAgents(
  options: Pick<ModelOptions, "USE_OPENROUTER" | "USE_TRACE"> & {
    model?: string;
  },
) {
  let openaiPrefix = "";
  if (options.USE_OPENROUTER) {
    openaiPrefix = "openai/";
    setOpenAIAPI("chat_completions");
  }
  const fetchWithPrettyJson = fetchProxyCurlLogger({
    logger: prettyJsonLogger,
  });
  const openaiOptions: ClientOptions = {
    ...(options.USE_OPENROUTER
      ? {
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: Deno.env.get(
          "OPENROUTER_API_KEY",
        ),
      }
      : {}),
    fetch: options.USE_TRACE ? fetchWithPrettyJson : undefined,
  };
  const customClient = new OpenAI(openaiOptions);
  setDefaultOpenAIClient(customClient);
  setTracingDisabled(true);

  const params = {
    model: options.model ??
      (options.USE_OPENROUTER
        ? "google/gemini-2.5-flash-preview-09-2025"
        : `${openaiPrefix}gpt-4.1-mini`),
  };

  const historyTutorAgent = new Agent({
    ...params,
    name: "History Tutor",
    instructions:
      "You provide assistance with historical queries. Explain important events and context clearly. Refuse to help with non-history question, explain why you think it is not history q.",
  });

  const mathTutorAgent = new Agent({
    ...params,
    name: "Math Tutor",
    instructions:
      "You provide help with math problems. Explain your reasoning at each step and include examples. Refuse to help with non-math questions",
  });

  const search = new Agent({
    ...params,
    name: "Search Agent",
    tools: [webSearchTool()],
    instructions:
      "You search web and answer questions using info in search results",
  });

  const agents = [historyTutorAgent, mathTutorAgent, search];

  try {
    const cwd = Deno.cwd();
    const server = new MCPServerStdio({
      fullCommand: "rs_filesystem --mcp",
      env: {
        "MCP_RS_FILESYSTEM_ALLOWED_DIRECTORIES": cwd,
      },
    });
    await server.connect();

    const fetchUrlTool = tool({
      name: "fetch_url",
      description: "Fetch the content of a given URL using the JS fetch API",
      parameters: z.object({ url: z.string() }),
      async execute({ url }) {
        const fetchUrl = `https://markdown.download/${url}`;
        const response = await fetch(fetchUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${fetchUrl}: ${response.statusText}`,
          );
        }
        return await response.text();
      },
    });

    const coder = new Agent({
      ...params,
      name: "Coder Agent",
      tools: [fetchUrlTool],
      instructions:
        `You are an agent for T Code. Given the user's prompt, you should use the tools available to you to answer the user's question.

Notes:
1. IMPORTANT: You should be concise, direct, and to the point, since your responses will be displayed on a command line interface. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as \"The answer is <answer>.\", \"Here is the content of the file...\" or \"Based on the information provided, the answer is...\" or \"Here is what I will do next...\".
2. When relevant, share file names and code snippets relevant to the query
3. Any file paths you return in your final response MUST be absolute. DO NOT use relative paths.
4. Consider multiple approaches to solving problems, prefer ones that minimize amount output, eg reduce info with  shell tools instead  of reading raw files when needed
5. make sure to commit modified files before editing them and also commit after edits
Here is useful information about the environment you are running in:
<env>
Working directory: ${cwd}
Is directory a git repo: Yes
Platform: ${process.platform}
Today's date: ${new Date().toISOString().split("T")[0]}
</env>
`,
      mcpServers: [server],
    });

    agents.push(coder);
  } catch (_e) {
    console.error(`Failed to load rs_filesystem mcp`);
  }

  const triageAgent = new Agent({
    ...params,
    name: "Triage Agent",
    instructions: RECOMMENDED_PROMPT_PREFIX +
      "You determine which agent to use based on the user's question",
    handoffs: agents,
  });

  agents.push(triageAgent);
  return agents;
}
