import fs from "fs/promises";

async function encodeAudioToBase64(audioPath: string): Promise<string> {
  const audioBuffer = await fs.readFile(audioPath);
  return audioBuffer.toString("base64");
}

// Read and encode the audio file
const audioPath = "write-hello-in-js.mp3";
const base64Audio = await encodeAudioToBase64(audioPath);

const input = {
  model: "google/gemini-3-pro-preview",
  // mistralai/voxtral-small-24b-2507",
  //google/gemini-2.5-flash",
  "reasoning": {
    // One of the following (not both):
    "effort": "high", // Can be "high", "medium", "low", "minimal" or "none" (OpenAI-style)
    // "max_tokens": 2000, // Specific token limit (Anthropic-style)
    // Optional: Default is false. All models support this.
    "exclude": false, // Set to true to exclude reasoning tokens from response
    // Or enable reasoning with the default parameters:
    "enabled": true, // Default: inferred from `effort` or `max_tokens`
  },
  messages: [{
    role: "system",
    content: [
      {
        type: "text",
        text:
          "###Think\nPlease repeat whats said in audio file, try to infer user intent, try to deal with poor audio. and then in `###Conclusion` section satisfy what user asked",
      },
    ],
  }, {
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: {
          data: base64Audio,
          format: "mp3",
        },
      },
      // {
      //   type: "text",
      //   text: "Do it!",
      // },
    ],
  }],
};
const response = await fetch(
  "https://openrouter.ai/api/v1/chat/completions",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  },
);

const data = await response.json();
// console.log(JSON.stringify(input, null, 2));
console.log(JSON.stringify(data));
