/**
 * Drives the real Claude Code CLI through Mimir's adapter, end to end, without an
 * Anthropic account: a scripted stand-in for the Messages API plays the model, so the
 * permission prompts, approvals and Mimir's ask rules for risky commands are exercised
 * by Claude Code itself, on macOS and on Windows (PowerShell included).
 *
 *   bun scripts/claude-check.ts
 *
 * The scripted model calls the tools named in the prompt, e.g.
 *   [[tool:Write {"file_path":"/abs/hello.txt","content":"hi"}]]
 * and ends the turn by repeating what the tools returned.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../packages/adapters/src/claude.ts";
import type { AdapterEvent } from "../packages/adapters/src/types.ts";
import { classifyApproval, GUARDED_SHELL_COMMANDS } from "../packages/core/src/policy.ts";

type Block = { type: string; text?: string; content?: unknown };
type Message = { role: string; content: string | Block[] };

const DIRECTIVE = /\[\[tool:(\w+) (\{.*?\})\]\]/g;
const offeredTools = new Set<string>();

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");
}

function toolResults(content: Message["content"]): string[] {
  if (typeof content === "string") return [];
  return content
    .filter((b) => b.type === "tool_result")
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
}

let ids = 0;

/** The scripted model's next answer. */
function answer(body: { messages: Message[]; tools?: Array<{ name: string }> }) {
  if (!body.tools?.length) return { blocks: [{ type: "text", text: "Check" }], stop: "end_turn" };
  for (const tool of body.tools) offeredTools.add(tool.name);
  // Claude Code appends system messages (environment, token budget) after the conversation.
  const convo = body.messages.filter((m) => m.role === "user" || m.role === "assistant");
  // This turn starts at the latest message with directives; earlier turns are history.
  let start = -1;
  convo.forEach((m, i) => {
    if (m.role === "user" && textOf(m.content).includes("[[tool:")) start = i;
  });
  if (start < 0) return { blocks: [{ type: "text", text: "Nothing to do." }], stop: "end_turn" };
  const calls = [...textOf(convo[start]?.content ?? "").matchAll(DIRECTIVE)];
  const made = convo.slice(start).filter((m) => m.role === "assistant").length;
  const next = calls[made];
  if (next) {
    const input = JSON.parse(next[2] ?? "{}");
    return { blocks: [{ type: "tool_use", id: `toolu_${++ids}`, name: next[1], input }], stop: "tool_use" };
  }
  const results = convo.slice(start).flatMap((m) => (m.role === "user" ? toolResults(m.content) : []));
  return { blocks: [{ type: "text", text: `Tool results: ${results.join(" || ")}` }], stop: "end_turn" };
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 42 });
    if (!url.pathname.startsWith("/v1/messages")) return new Response("not found", { status: 404 });
    const body = (await request.json()) as {
      model: string;
      stream?: boolean;
      messages: Message[];
      tools?: Array<{ name: string }>;
    };
    const { blocks, stop } = answer(body);
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const message = {
      id: `msg_${++ids}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [] as unknown[],
      stop_reason: null,
      stop_sequence: null,
      usage,
    };
    if (!body.stream) return Response.json({ ...message, content: blocks, stop_reason: stop });
    let out = sse("message_start", { type: "message_start", message });
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        out += sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: (block as { text: string }).text },
        });
      } else {
        const { input, ...rest } = block as { input: unknown };
        out += sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { ...rest, input: {} },
        });
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        });
      }
      out += sse("content_block_stop", { type: "content_block_stop", index });
    });
    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage,
    });
    out += sse("message_stop", { type: "message_stop" });
    return new Response(out, { headers: { "content-type": "text/event-stream" } });
  },
});

// Claude Code in a throwaway config folder, talking to the scripted model.
const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir claude check ")));
const config = join(root, "config");
const project = join(root, "my app ü");
mkdirSync(config, { recursive: true });
mkdirSync(join(project, "build"), { recursive: true });
const env = {
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  ANTHROPIC_API_KEY: "sk-ant-mimir-check",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  // With Git for Windows installed Claude Code uses Git Bash; this adds its PowerShell tool.
  ...(process.platform === "win32" ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" } : {}),
};

let failures = 0;
const ok = (name: string, detail = "") => console.log(`ok    ${name}${detail ? `  (${detail})` : ""}`);
const fail = (name: string, detail = "") => {
  failures += 1;
  console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
};
const check = (name: string, pass: boolean, detail = "") => (pass ? ok : fail)(name, detail);

const adapter = new ClaudeCodeAdapter({
  projectsDir: join(config, "projects"),
  settingsDir: join(root, "settings"),
  env,
});
const health = await adapter.health();
if (!health.ok) {
  console.log(`Claude Code is not installed here (${health.error}); nothing to check.`);
  process.exit(0);
}
console.log(`Claude Code ${health.version}, scripted model on port ${server.port}\n`);

function next<T extends AdapterEvent["type"]>(...types: T[]): Promise<Extract<AdapterEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no ${types.join("/")} within 90s`));
    }, 90_000);
    const stop = adapter.onEvent((event) => {
      if (!types.includes(event.type as T)) return;
      clearTimeout(timer);
      stop();
      resolve(event as Extract<AdapterEvent, { type: T }>);
    });
  });
}

const call = (tool: string, input: Record<string, unknown>) => `[[tool:${tool} ${JSON.stringify(input)}]]`;
const file = (name: string) => join(project, name);
const userSettings = (settings: unknown) =>
  writeFileSync(join(config, "settings.json"), JSON.stringify(settings));

async function scenario(name: string, body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

let sessionId = "";

/** A new session, so grants from earlier checks (e.g. "allow all edits") don't apply. */
async function fresh(prompt: string): Promise<string> {
  const { externalId } = await adapter.createSession({
    directory: project,
    title: "check",
    prompt,
    guardedCommands: GUARDED_SHELL_COMMANDS,
  });
  return externalId;
}

await scenario("a write asks Mimir first, and approving lets it through", async () => {
  const asked = next("permission.asked");
  ({ externalId: sessionId } = await adapter.createSession({
    directory: project,
    title: "check",
    prompt: `Create it. ${call("Write", { file_path: file("hello.txt"), content: "hi from Mimir" })}`,
    guardedCommands: GUARDED_SHELL_COMMANDS,
  }));
  const request = await asked;
  const tier = classifyApproval(request.action, request.resources);
  check(
    "Claude Code asks before writing",
    request.action === "edit" && request.resources[0] === "hello.txt" && tier === "confirm",
    `${request.action} ${request.resources.join(" ")}, tier ${tier}, always: ${request.always}`,
  );
  const done = next("succeeded", "failed");
  await adapter.replyPermission(sessionId, request.requestId, "once");
  const end = await done;
  check(
    "approving lets it write",
    end.type === "succeeded" && readFileSync(file("hello.txt"), "utf8") === "hi from Mimir",
    end.type,
  );
});

await scenario("rejecting stops the turn", async () => {
  const asked = next("permission.asked");
  await adapter.prompt(
    { externalId: sessionId, directory: project },
    `Two files. ${call("Write", { file_path: file("no1.txt"), content: "x" })} ${call("Write", { file_path: file("no2.txt"), content: "x" })}`,
    GUARDED_SHELL_COMMANDS,
  );
  const request = await asked;
  const end = next("interrupted", "succeeded", "failed");
  await adapter.replyPermission(sessionId, request.requestId, "reject");
  const outcome = await end;
  check(
    "a rejected write stops the turn, nothing written",
    outcome.type === "interrupted" && !existsSync(file("no1.txt")) && !existsSync(file("no2.txt")),
    outcome.type === "interrupted" ? `interrupted: ${outcome.reason}` : outcome.type,
  );
});

await scenario("'always' covers the rest of the session", async () => {
  const asked = next("permission.asked");
  await adapter.prompt(
    { externalId: sessionId, directory: project },
    `Edit. ${call("Write", { file_path: file("a.txt"), content: "a" })}`,
    GUARDED_SHELL_COMMANDS,
  );
  const request = await asked;
  let done = next("succeeded", "failed");
  await adapter.replyPermission(sessionId, request.requestId, "always");
  await done;
  let askedAgain = false;
  const stop = adapter.onEvent((event) => {
    if (event.type === "permission.asked") askedAgain = true;
  });
  done = next("succeeded", "failed");
  await adapter.prompt(
    { externalId: sessionId, directory: project },
    `Again. ${call("Write", { file_path: file("b.txt"), content: "b" })}`,
    GUARDED_SHELL_COMMANDS,
  );
  const end = await done;
  stop();
  check(
    "a later turn of the session edits without asking",
    end.type === "succeeded" && !askedAgain && existsSync(file("b.txt")),
    askedAgain ? "it asked again" : end.type,
  );
});

// Shell commands, in every shell Claude Code offers here (PowerShell on Windows).
const shells = [...offeredTools].filter((t) => t === "Bash" || t === "PowerShell");
check("Claude Code offers a shell", shells.length > 0, [...offeredTools].join(", "));
const ordinary: Record<string, string> = {
  Bash: "touch made-by-bash.txt",
  PowerShell: "New-Item -ItemType File -Path made-by-powershell.txt",
};
const risky: Record<string, string[]> = {
  Bash: ["rm -rf build", "git push origin main"],
  PowerShell: ["Remove-Item -Recurse -Force build", "rm -r build", "git push origin main"],
};

for (const shell of shells) {
  await scenario(`${shell}: an ordinary command asks, and runs once approved`, async () => {
    const asked = next("permission.asked");
    const id = await fresh(
      `Run it. ${call(shell, { command: ordinary[shell], description: "Make a file" })}`,
    );
    const request = await asked;
    const tier = classifyApproval(request.action, request.resources);
    const done = next("succeeded", "failed");
    await adapter.replyPermission(id, request.requestId, "once");
    await done;
    const made = file(shell === "Bash" ? "made-by-bash.txt" : "made-by-powershell.txt");
    check(
      `${shell}: an ordinary command asks, and runs once approved`,
      tier === "confirm" && existsSync(made),
      `${request.resources[0]}, tier ${tier}`,
    );
  });
}

// The user's own settings allow everything and skip prompts; Mimir's ask rules still hold.
userSettings({
  permissions: {
    defaultMode: "bypassPermissions",
    allow: [
      "Bash(rm *)",
      "Bash(git push *)",
      "PowerShell(Remove-Item *)",
      "PowerShell(rm *)",
      "PowerShell(git push *)",
    ],
  },
  skipDangerousModePermissionPrompt: true,
});
for (const shell of shells) {
  for (const command of risky[shell] ?? []) {
    await scenario(`${shell}: ${command} waits for a screen, even in bypass mode`, async () => {
      const asked = next("permission.asked", "succeeded", "failed");
      await adapter.prompt(
        { externalId: sessionId, directory: project },
        `Do it. ${call(shell, { command, description: "Risky" })}`,
        GUARDED_SHELL_COMMANDS,
      );
      const request = await asked;
      if (request.type !== "permission.asked") {
        fail(`${shell}: ${command} waits for a screen, even in bypass mode`, `not asked: ${request.type}`);
        return;
      }
      const tier = classifyApproval(request.action, request.resources);
      const end = next("interrupted", "succeeded", "failed");
      await adapter.replyPermission(sessionId, request.requestId, "reject");
      await end;
      check(
        `${shell}: ${command} waits for a screen, even in bypass mode`,
        tier === "screen" && existsSync(join(project, "build")),
        `tier ${tier}`,
      );
    });
  }
}
userSettings({});

await scenario("a request whose run was stopped expires", async () => {
  const asked = next("permission.asked");
  const id = await fresh(`Wait. ${call("Write", { file_path: file("never.txt"), content: "x" })}`);
  const request = await asked;
  const expired = next("permission.expired");
  await adapter.interrupt(id);
  const gone = await expired;
  check(
    "stopping a waiting run expires its request",
    gone.requestId === request.requestId && !existsSync(file("never.txt")),
  );
});

await adapter.stop();
server.stop(true);
await Bun.sleep(1000);
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  console.log(`(left ${root} behind)`);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
