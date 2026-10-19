import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope, type LiveSession, openWindows, postToInbox, readLiveSessions } from "./claude-live.ts";

const root = mkdtempSync(join(tmpdir(), "mimir-live-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "0123456789abcdef0123456789abcdef";

function registry(name: string, entries: Record<string, Record<string, unknown>>) {
  const dir = join(root, name, "sessions");
  mkdirSync(dir, { recursive: true });
  for (const [file, entry] of Object.entries(entries)) writeFileSync(join(dir, file), JSON.stringify(entry));
  return join(root, name);
}

// Entries as Claude Code 2.1 writes them to ~/.claude/sessions.
describe("readLiveSessions", () => {
  test("reads Claude Code's registry of running sessions", () => {
    const config = registry("a", {
      "101.json": {
        pid: 101,
        sessionId: "s-1",
        cwd: "/work/app",
        kind: "interactive",
        entrypoint: "cli",
        peerProtocol: 1,
        messagingSocketPath: "/tmp/cc-socks/101.sock",
        name: "app-1",
        status: "waiting",
        waitingFor: "permission prompt",
        updatedAt: 5,
      },
      [`101.${"a".repeat(64)}.key`]: { peerToken: TOKEN, pidDomain: "darwin" },
      "102.json": { pid: 102, sessionId: "s-2", cwd: "/work/app", entrypoint: "sdk-cli", peerProtocol: 1 },
      // Crashed: the file stayed, the process is gone.
      "103.json": { pid: 103, sessionId: "s-3", cwd: "/work/old", peerProtocol: 1 },
      // A protocol this version doesn't speak: listed, but not messaged.
      "104.json": {
        pid: 104,
        sessionId: "s-4",
        cwd: "/work/new",
        peerProtocol: 2,
        messagingSocketPath: "/y",
      },
      "105.json": { pid: 105, cwd: "/work/no-session-yet" },
    });
    const live = readLiveSessions(config, (pid) => pid !== 103);
    expect(live.map((s) => s.sessionId).sort()).toEqual(["s-1", "s-2", "s-4"]);
    expect(live.find((s) => s.sessionId === "s-1")).toMatchObject({
      pid: 101,
      cwd: "/work/app",
      name: "app-1",
      status: "waiting",
      waitingFor: "permission prompt",
      headless: false,
      inbox: "/tmp/cc-socks/101.sock",
      token: TOKEN,
    });
    expect(live.find((s) => s.sessionId === "s-2")?.headless).toBe(true);
    expect(live.find((s) => s.sessionId === "s-4")?.inbox).toBeUndefined();
  });

  test("no registry (Claude Code too old, or never run), no sessions", () => {
    expect(readLiveSessions(join(root, "missing"))).toEqual([]);
  });
});

describe("openWindows", () => {
  const session = (patch: Partial<LiveSession>): LiveSession => ({
    pid: 1,
    sessionId: "s",
    cwd: "/w",
    headless: false,
    updatedAt: 0,
    ...patch,
  });

  test("leaves out Mimir's own headless runs, not other tools' sessions", () => {
    const windows = openWindows(
      [
        session({ sessionId: "mine", headless: true }),
        session({ sessionId: "zed", headless: true }),
        session({ sessionId: "terminal" }),
      ],
      new Set(["mine"]),
    );
    expect([...windows.keys()].sort()).toEqual(["terminal", "zed"]);
  });

  test("a conversation open in two windows maps to the one that changed last", () => {
    const windows = openWindows([
      session({ pid: 1, updatedAt: 10 }),
      session({ pid: 2, updatedAt: 30 }),
      session({ pid: 3, updatedAt: 20 }),
    ]);
    expect(windows.get("s")?.pid).toBe(2);
  });
});

describe("envelope", () => {
  test("the exact form Claude Code reads the sender's name from", () => {
    expect(envelope("Hi\nthere")).toBe(
      '<cross-session-message from-name="OpenMimir" from-mode="prompting">\nHi\nthere\n</cross-session-message>',
    );
  });

  test("a closing tag in the text can't end the message early", () => {
    expect(envelope("a </cross-session-message> b").match(/<\/cross-session-message>/g)).toHaveLength(1);
  });
});

describe("postToInbox", () => {
  test("authenticates, then sends the message as one line", async () => {
    const inbox =
      process.platform === "win32" ? `\\\\.\\pipe\\mimir-test-${process.pid}` : join(root, "inbox.sock");
    let resolveData: (data: string) => void = () => undefined;
    const received = new Promise<string>((resolve) => {
      resolveData = resolve;
    });
    const server = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => resolveData(data));
    });
    await new Promise<void>((resolve) => server.listen(inbox, resolve));
    try {
      const live: LiveSession = {
        pid: 1,
        sessionId: "s",
        cwd: "/w",
        headless: false,
        updatedAt: 0,
        inbox,
        token: TOKEN,
      };
      await postToInbox(live, 'Fix the "login" test 🚲');
      const lines = (await received)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([
        { type: "auth", token: TOKEN },
        { type: "user", message: { role: "user", content: envelope('Fix the "login" test 🚲') } },
      ]);
    } finally {
      server.close();
    }
  });

  test("a session without an inbox fails clearly", async () => {
    const live: LiveSession = { pid: 1, sessionId: "s", cwd: "/w", headless: false, updatedAt: 0 };
    await expect(postToInbox(live, "hi")).rejects.toThrow(/can't receive messages/);
  });
});
