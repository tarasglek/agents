import { Agent, run } from "@openai/agents";

const params = {
  model: "gpt-4.1-nano",
};

const historyTutorAgent = new Agent({
  ...params,
  name: "History Tutor",
  instructions:
    "You provide assistance with historical queries. Explain important events and context clearly.",
});

const mathTutorAgent = new Agent({
  ...params,
  name: "Math Tutor",
  instructions:
    "You provide help with math problems. Explain your reasoning at each step and include examples",
});

const triageAgent = new Agent({
  ...params,
  name: "Triage Agent",
  instructions:
    "You determine which agent to use based on the user's homework question",
  handoffs: [historyTutorAgent, mathTutorAgent],
});

async function main() {
  const result = await run(triageAgent, "What is the capital of France?", {
    stream: true,
  });
  console.log(result.finalOutput);
}

main().catch((err) => console.error(err));
