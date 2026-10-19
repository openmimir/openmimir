import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "./claude.ts";
import { envelope } from "./claude-live.ts";
import type { AdapterEvent } from "./types.ts";

// A fake `claude` installed the way npm installs CLIs (a .cmd shim on Windows), so this
// runs the real launch path: finding the command, JSON messages on stdin, stream-json
// out, and permission requests answered over the same pipes (--permission-prompt-tool stdio).
const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir run test ")));
const bin = join(root, "bin");
const projects = join(root, "projects");
const work = join(root, "work ü");
const settingsDir = join(root, "settings");
mkdirSync(work, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(bin, "node_modules", "fake-claude"), { recursive: true });
writeFileSync(
  join(bin, "node_modules", "fake-claude", "cli.js"),
  `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const projects = path.join(__dirname, "..", "..", "..", "projects");
fs.mkdirSync(projects, { recursive: true });
const args = process.argv.slice(2);
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const log = (name, value) => fs.appendFileSync(path.join(projects, name), JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let sessionId;
let mode = args.includes("--permission-mode") ? args[args.indexOf("--permission-mode") + 1] : "default";
let writing;

function finish(text) {
  send({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } });
  send({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId });
}

function write(file) {
  writing = path.join(process.cwd(), file);
  if (mode === "acceptEdits") {
    fs.writeFileSync(writing, "written");
    return finish("wrote " + file);
  }
  send({
    type: "control_request",
    request_id: "req-" + sessionId + "-" + file,
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      input: { file_path: writing, content: "written" },
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      tool_use_id: "toolu_1",
    },
  });
}

function onPrompt(prompt) {
  sessionId = resume || (/\\[session:([\\w-]+)\\]/.exec(prompt) || [])[1] || "fake-session";
  const dir = path.join(projects, "repo");
  fs.mkdirSync(dir, { recursive: true });
  const entry = { type: "user", cwd: process.cwd(), message: { role: "user", content: prompt } };
  fs.appendFileSync(path.join(dir, sessionId + ".jsonl"), JSON.stringify(entry) + "\\n");
  fs.writeFileSync(path.join(projects, "args-" + sessionId + ".json"), JSON.stringify(args));
  send({ type: "system", subtype: "init", session_id: sessionId, permissionMode: mode });
  // Like a run that fails before answering (e.g. not logged in): the transcript ends on the prompt.
  if (prompt.includes("[fail]")) process.exit(1);
  const file = (/\\[write:([\\w.-]+)\\]/.exec(prompt) || [])[1];
  if (file) write(file);
  else finish("done");
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log("stdin.jsonl", message);
  if (message.type === "user") onPrompt(message.message.content);
  if (message.type === "control_response") {
    const answer = message.response.response;
    if (answer.behavior === "allow") {
      if ((answer.updatedPermissions || []).some((p) => p.mode === "acceptEdits")) mode = "acceptEdits";
      fs.writeFileSync(answer.updatedInput.file_path, answer.updatedInput.content);
      finish("wrote " + path.basename(writing));
    } else {
      send({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
      process.exit(1);
    }
  }
}).on("close", () => process.exit(0));
`,
);
if (process.platform === "win32") {
  writeFileSync(
    join(bin, "fake-claude.cmd"),
    `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0\\node_modules\\fake-claude\\cli.js" %*\r\n`,
  );
} else {
  writeFileSync(
    join(bin, "fake-claude"),
    `#!/bin/sh\nexec node "$(dirname "$0")/node_modules/fake-claude/cli.js" "$@"\n`,
    {
      mode: 0o755,
    },
  );
}

function setup() {
  const adapter = new ClaudeCodeAdapter({
    binary: join(bin, "fake-claude"),
    projectsDir: projects,
    settingsDir,
  });
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  const next = <T extends AdapterEvent["type"]>(type: T) =>
    new Promise<Extract<AdapterEvent, { type: T }>>((resolve) => {
      const stop = adapter.onEvent((event) => {
        if (event.type !== type) return;
        stop();
        resolve(event as Extract<AdapterEvent, { type: T }>);
      });
    });
  return { adapter, events, next };
}

type Sent = {
  type: string;
  message?: { content: string };
  request?: { subtype: string };
  response?: { response: Record<string, unknown> };
};

/** Everything Mimir wrote to the fake's stdin so far (tests run one at a time). */
function stdinLog(): Sent[] {
  const all = readFileSync(join(projects, "stdin.jsonl"), "utf8").trim().split("\n");
  return all.map((line) => JSON.parse(line));
}

describe("Claude Code headless runs", () => {
  test("the prompt goes in on stdin, risky commands ask, and a run that ended is not shown as running", async () => {
    const { adapter, next } = setup();
    const failed = next("failed");
    const prompt = 'Fix the "login" test & check 100% of %PATH%\nsecond line, héllo 🚲 [fail]';
    const { externalId } = await adapter.createSession({
      directory: work,
      title: "test",
      prompt,
      guardedCommands: ["*git push*", "*Remove-Item*-Recurse*"],
    });
    expect(externalId).toBe("fake-session");
    await failed;

    const sent = stdinLog().find((m) => m.type === "user");
    expect(sent?.message?.content).toBe(prompt);
    const args = JSON.parse(readFileSync(join(projects, "args-fake-session.json"), "utf8")) as string[];
    expect(args).not.toContain(prompt);
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("AskUserQuestion");
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1] as string, "utf8"));
    expect(settings.permissions.ask).toContain("Bash(git push *)");
    expect(settings.permissions.ask).toContain("PowerShell(git push *)");
    expect(settings.permissions.ask).toContain("PowerShell(Remove-Item*-Recurse*)");

    const [summary] = await adapter.listRecent(5);
    expect(summary?.externalId).toBe("fake-session");
    expect(summary?.title).toContain('Fix the "login" test');
    // The transcript ends on the prompt (it looks mid-turn), but Mimir saw the run end.
    expect(summary?.running).toBe(false);
  });

  test("Claude asks Mimir before writing, and approving lets it write", async () => {
    const { adapter, next } = setup();
    const asked = next("permission.asked");
    const { externalId } = await adapter.createSession({
      directory: work,
      title: "t",
      prompt: "[session:approve] Create it [write:hello.txt]",
      guardedCommands: [],
    });
    const request = await asked;
    expect(request).toMatchObject({
      externalId,
      action: "edit",
      resources: ["hello.txt"],
      always: "Allow all edits in this session",
    });
    const done = next("succeeded");
    await adapter.replyPermission(externalId, request.requestId, "once");
    await done;
    expect(readFileSync(join(work, "hello.txt"), "utf8")).toBe("written");
  });

  test("rejecting stops the turn, as Esc does in Claude Code", async () => {
    const { adapter, events, next } = setup();
    const asked = next("permission.asked");
    const { externalId } = await adapter.createSession({
      directory: work,
      title: "t",
      prompt: "[session:reject] [write:nope.txt]",
      guardedCommands: [],
    });
    const request = await asked;
    const stopped = next("interrupted");
    await adapter.replyPermission(externalId, request.requestId, "reject");
    expect((await stopped).reason).toBe("rejected");
    expect(events.some((e) => e.type === "failed")).toBe(false);
    expect(existsSync(join(work, "nope.txt"))).toBe(false);
    const answer = stdinLog().findLast((m) => m.type === "control_response");
    expect(answer?.response?.response).toMatchObject({ behavior: "deny", interrupt: true });
  });

  test("'always' lasts for the rest of the session, also in later turns", async () => {
    const { adapter, events, next } = setup();
    const asked = next("permission.asked");
    const { externalId } = await adapter.createSession({
      directory: work,
      title: "t",
      prompt: "[session:always] [write:first.txt]",
      guardedCommands: [],
    });
    let done = next("succeeded");
    await adapter.replyPermission(externalId, (await asked).requestId, "always");
    await done;
    const answer = stdinLog().findLast((m) => m.type === "control_response");
    expect(answer?.response?.response.updatedPermissions).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);

    // A new run of the same session starts in accept-edits mode, so nothing is asked.
    done = next("succeeded");
    const before = events.filter((e) => e.type === "permission.asked").length;
    await adapter.prompt({ externalId, directory: work }, "[write:second.txt]", []);
    await done;
    expect(events.filter((e) => e.type === "permission.asked").length).toBe(before);
    expect(readFileSync(join(work, "second.txt"), "utf8")).toBe("written");
    const args = JSON.parse(readFileSync(join(projects, `args-${externalId}.json`), "utf8")) as string[];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  test("a request whose run was stopped can no longer be answered", async () => {
    const { adapter, next } = setup();
    const asked = next("permission.asked");
    const { externalId } = await adapter.createSession({
      directory: work,
      title: "t",
      prompt: "[session:stopped] [write:never.txt]",
      guardedCommands: [],
    });
    const request = await asked;
    const expired = next("permission.expired");
    const stopped = next("interrupted");
    await adapter.interrupt(externalId);
    expect((await expired).requestId).toBe(request.requestId);
    expect((await stopped).reason).toBe("user");
    await expect(adapter.replyPermission(externalId, request.requestId, "once")).rejects.toThrow(
      /no longer waiting/,
    );
    expect(existsSync(join(work, "never.txt"))).toBe(false);
  });

  test("a message to a session open in a window goes into that window, and Mimir follows it there", async () => {
    const { adapter, next } = setup();
    const id = "open-window";
    mkdirSync(join(projects, "repo"), { recursive: true });
    const entry = { type: "user", cwd: work, message: { role: "user", content: "earlier work" } };
    writeFileSync(join(projects, "repo", `${id}.jsonl`), `${JSON.stringify(entry)}\n`);

    // The window's inbox, and Claude Code's registry entry for it.
    const inbox =
      process.platform === "win32" ? `\\\\.\\pipe\\mimir-window-${process.pid}` : join(root, "window.sock");
    const received: string[] = [];
    const server = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => received.push(data));
    });
    await new Promise<void>((resolve) => server.listen(inbox, resolve));
    const registry = join(root, "sessions", `${process.pid}.json`);
    mkdirSync(join(root, "sessions"), { recursive: true });
    const window = {
      pid: process.pid,
      sessionId: id,
      cwd: work,
      entrypoint: "cli",
      peerProtocol: 1,
      messagingSocketPath: inbox,
      status: "idle",
      updatedAt: Date.now(),
    };
    const show = (patch: Record<string, unknown>) =>
      writeFileSync(registry, JSON.stringify({ ...window, ...patch }));
    show({});
    try {
      const listed = (await adapter.listRecent(10)).find((s) => s.externalId === id);
      expect(listed?.open).toBe(true);

      const started = next("started");
      await adapter.prompt({ externalId: id, directory: work }, "Please add a volume slider", []);
      await started;
      await Bun.sleep(200);
      expect(received.join("")).toContain(JSON.stringify(envelope("Please add a volume slider")));
      // No second Claude process on a conversation that is open in a window.
      expect(existsSync(join(projects, `args-${id}.json`))).toBe(false);

      const waiting = next("waiting");
      show({ status: "waiting", waitingFor: "permission prompt" });
      expect((await waiting).reason).toBe("permission prompt");
      const resumed = next("started");
      show({ status: "busy" });
      await resumed;
      const done = next("succeeded");
      show({ status: "idle" });
      await done;
      await expect(adapter.interrupt(id)).rejects.toThrow(/Press Esc there/);
    } finally {
      rmSync(registry, { force: true });
      server.close();
      await adapter.stop();
    }
  }, 20_000);
});
