import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";

const root = mkdtempSync(join(tmpdir(), "mimir-detect-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

function write(path: string, content: string, ageMs = 0) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const time = (Date.now() - ageMs) / 1000;
  utimesSync(path, time, time);
}

describe("Claude Code running detection", () => {
  const dir = join(root, "claude", "-repo");
  const user = (text: string) => ({ type: "user", cwd: "/repo", message: { role: "user", content: text } });
  const assistant = (stop: string, content: unknown[]) => ({
    type: "assistant",
    message: { stop_reason: stop, content },
  });
  const toolResult = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  };
  const adapter = new ClaudeCodeAdapter({ projectsDir: join(root, "claude") });

  write(
    join(dir, "finished.jsonl"),
    jsonl([user("fix it"), assistant("end_turn", [{ type: "text", text: "Fixed." }])]),
  );
  write(
    join(dir, "tool-running.jsonl"),
    jsonl([user("fix it"), assistant("tool_use", [{ type: "tool_use" }]), toolResult]),
  );
  write(join(dir, "just-prompted.jsonl"), jsonl([user("fix it")]));
  write(
    join(dir, "stale.jsonl"),
    jsonl([user("fix it"), assistant("tool_use", [{ type: "tool_use" }])]),
    60 * 60_000,
  );

  test("reads each session's state from its transcript", async () => {
    const byId = new Map((await adapter.listRecent(10)).map((s) => [s.externalId, s]));
    expect(byId.get("finished")?.running).toBe(false);
    expect(byId.get("finished")?.lastText).toBe("Fixed.");
    expect(byId.get("tool-running")?.running).toBe(true);
    expect(byId.get("just-prompted")?.running).toBe(true);
    expect(byId.get("stale")?.running).toBe(false);
  });
});

describe("Codex running detection", () => {
  const day = join(root, "codex", "2026", "09", "30");
  const meta = (id: string) => ({ type: "session_meta", payload: { id, cwd: "/repo" } });
  const event = (type: string, extra: object = {}) => ({ type: "event_msg", payload: { type, ...extra } });
  const message = (kind: string, text: string) =>
    event("item_completed", { item: { type: kind, content: [{ type: "Text", text }] } });
  const adapter = new CodexAdapter({ sessionsDir: join(root, "codex") });

  write(
    join(day, "rollout-a-finished.jsonl"),
    jsonl([
      meta("finished"),
      event("task_started"),
      message("UserMessage", "review it"),
      message("AgentMessage", "Looks good."),
      event("task_complete"),
    ]),
  );
  write(
    join(day, "rollout-b-running.jsonl"),
    jsonl([meta("running"), event("task_started"), message("UserMessage", "review it")]),
  );
  write(
    join(day, "rollout-c-second-turn.jsonl"),
    jsonl([meta("second-turn"), event("task_started"), event("task_complete"), event("task_started")]),
  );
  write(join(day, "rollout-d-stale.jsonl"), jsonl([meta("stale"), event("task_started")]), 60 * 60_000);
  write(
    join(day, "rollout-e-subagent.jsonl"),
    jsonl([{ type: "session_meta", payload: { id: "sub", cwd: "/repo", thread_source: "subagent" } }]),
  );

  test("reads each session's state from its rollout", async () => {
    const byId = new Map((await adapter.listRecent(10)).map((s) => [s.externalId, s]));
    expect(byId.get("finished")?.running).toBe(false);
    expect(byId.get("finished")?.lastText).toBe("Looks good.");
    expect(byId.get("finished")?.title).toBe("review it");
    expect(byId.get("running")?.running).toBe(true);
    expect(byId.get("second-turn")?.running).toBe(true);
    expect(byId.get("stale")?.running).toBe(false);
    expect(byId.has("sub")).toBe(false);
  });
});
