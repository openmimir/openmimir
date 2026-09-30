// Generates the dialogue with OpenAI TTS. Mimir uses "marin", the voice the app uses live.
// Usage: bun tools/voices.ts   (needs OPENAI_API_KEY)
const lines: Array<[string, "user" | "mimir", string]> = [
  ["u1", "user", "How's the billing refactor going?"],
  ["m1", "mimir", "Codex is on the last migration, three of four. The tests are passing."],
  ["u2", "user", "Nice. Have Claude fix the flaky login test in web-app."],
  ["m2", "mimir", "I'll start Claude Code in web-app to fix the flaky login test. Go ahead?"],
  ["u3", "user", "Yes."],
  ["m3", "mimir", "On it. I'll tell you when it's done."],
  ["m4", "mimir", "Claude fixed it. The test was racing the session cookie. It now waits for it, and passed fifty runs in a row."],
];
const style = {
  user: { voice: "cedar", instructions: "A developer riding an indoor bike trainer: relaxed, casual, slightly out of breath. Natural, not theatrical." },
  mimir: { voice: "marin", instructions: "A calm, warm, concise assistant. Clear and friendly, unhurried, like a capable colleague giving a quick update." },
};
for (const [id, who, text] of lines.filter(([id]) => process.argv.slice(2).length === 0 || process.argv.slice(2).includes(id))) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", input: text, response_format: "wav", ...style[who] }),
  });
  if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
  await Bun.write(`assets/voice/${id}.wav`, await res.arrayBuffer());
  console.log(id, who);
}
