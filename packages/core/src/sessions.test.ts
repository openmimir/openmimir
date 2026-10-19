import { describe, expect, test } from "bun:test";
import type { AgentAdapter, FileChange, SessionSummary } from "@openmimir/adapters";
import type { AgentKind, AgentSession } from "@openmimir/protocol";
import { EventBus } from "./bus.ts";
import { type Announcement, SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

/** An agent whose session list the test controls. */
class FakeAdapter implements AgentAdapter {
  readonly kind = "opencode" as const;
  readonly supportsApprovals = true;
  recent: SessionSummary[] = [];
  prompts: string[] = [];
  lastText: string | undefined;
  private listeners = new Set<(event: Parameters<Parameters<AgentAdapter["onEvent"]>[0]>[0]) => void>();

  async start() {}
  async stop() {}
  async health() {
    return { ok: true };
  }
  async listRecent() {
    return this.recent;
  }
  archive: SessionSummary[] = [];
  async search(query: { text?: string }) {
    return this.archive.filter(
      (s) => !query.text || s.title.toLowerCase().includes(query.text.toLowerCase()),
    );
  }
  async createSession(input: { directory: string; title: string; prompt: string }) {
    this.prompts.push(input.prompt);
    this.recent.unshift(summary("new", { title: input.title, running: true }));
    return { externalId: "new" };
  }
  async prompt(_session: { externalId: string }, text: string) {
    this.prompts.push(text);
  }
  async interrupt() {}
  async lastAssistantText() {
    return this.lastText;
  }
  async diff(): Promise<FileChange[]> {
    return [];
  }
  async replyPermission(_externalId: string, _requestId: string, _decision: string) {
    await this.onReply();
  }
  onReply: () => Promise<void> = async () => undefined;
  approvalsEndWithRun = false;
  onEvent(listener: (event: Parameters<Parameters<AgentAdapter["onEvent"]>[0]>[0]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: Parameters<Parameters<AgentAdapter["onEvent"]>[0]>[0]) {
    for (const listener of this.listeners) listener(event);
  }
}

function summary(externalId: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    externalId,
    title: `Session ${externalId}`,
    directory: "/repo",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    running: false,
    ...patch,
  };
}

function setup() {
  const adapter = new FakeAdapter();
  const store = new Store(":memory:");
  const manager = new SessionManager(
    new Map<AgentKind, AgentAdapter>([["opencode", adapter]]),
    store,
    new EventBus(),
  );
  const spoken: Announcement[] = [];
  manager.onAnnouncement((a) => spoken.push(a));
  const status = (id: string) => manager.list().find((s) => s.id === id)?.status;
  return { adapter, store, manager, spoken, status };
}

describe("SessionManager", () => {
  test("a session the user runs elsewhere goes idle when it finishes, even after Mimir looked at it", async () => {
    const { adapter, manager, status } = setup();
    adapter.recent = [summary("a", { running: true })];
    await manager.refresh(true);
    manager.focus("opencode:a"); // stores a copy while it is still running
    expect(status("opencode:a")).toBe("working");

    adapter.recent = [summary("a", { running: false })];
    await manager.refresh(true);
    expect(status("opencode:a")).toBe("idle");
    expect(manager.get("opencode:a")?.status).toBe("idle");
    expect(manager.get("opencode:a")?.focusedAt).toBeDefined();
  });

  test("a session Mimir started reports its full result when it finishes", async () => {
    const { adapter, manager, spoken, status } = setup();
    const session = await manager.start({
      agent: "opencode",
      directory: "/repo",
      title: "Fix it",
      instructions: "fix",
    });
    expect(session.id).toBe("opencode:new");
    adapter.lastText = "All tests pass. Changed three files.";
    adapter.emit({ type: "succeeded", externalId: "new" });
    expect(status("opencode:new")).toBe("idle");
    await Bun.sleep(0);
    expect(spoken.map((a) => a.kind)).toEqual(["started", "finished"]);
    expect(spoken[1]?.result).toBe("All tests pass. Changed three files.");
  });

  test("a status change is not undone by the next refresh", async () => {
    const { adapter, manager, status } = setup();
    await manager.start({ agent: "opencode", directory: "/repo", title: "Fix it", instructions: "fix" });
    adapter.recent = [summary("new", { running: true })];
    await manager.refresh(true);
    expect(status("opencode:new")).toBe("working");
    adapter.recent = [summary("new", { running: false })];
    adapter.emit({ type: "succeeded", externalId: "new" });
    expect(status("opencode:new")).toBe("idle");
  });

  test("a tracked session the user resumes elsewhere shows as working, then idle once quiet", async () => {
    const { adapter, store, manager, status } = setup();
    await manager.start({ agent: "opencode", directory: "/repo", title: "Fix it", instructions: "fix" });
    adapter.emit({ type: "succeeded", externalId: "new" });

    adapter.recent = [summary("new", { running: true })];
    await manager.refresh(true);
    expect(status("opencode:new")).toBe("working");

    // Stored as working now; once the agent reports it idle and it has been quiet, it settles.
    const stored = store.session("opencode:new") as AgentSession;
    store.saveSession({ ...stored, status: "working", updatedAt: Date.now() - 60_000 });
    adapter.recent = [summary("new", { running: false, updatedAt: Date.now() - 60_000 })];
    await manager.refresh(true);
    expect(status("opencode:new")).toBe("idle");
  });

  test("only sessions Mimir drove are narrated", async () => {
    const { adapter, manager, spoken } = setup();
    adapter.recent = [summary("theirs", { running: true })];
    await manager.refresh(true);
    manager.focus("opencode:theirs");
    adapter.emit({ type: "succeeded", externalId: "theirs" });
    expect(spoken).toEqual([]);

    await manager.message("opencode:theirs", "carry on");
    adapter.emit({ type: "succeeded", externalId: "theirs" });
    await Bun.sleep(0);
    expect(spoken.map((a) => a.kind)).toEqual(["finished"]);
  });

  test("sessions that fell off the agent's recent list are still listed", async () => {
    const { adapter, manager } = setup();
    await manager.start({ agent: "opencode", directory: "/repo", title: "Old work", instructions: "x" });
    adapter.recent = [summary("other")];
    await manager.refresh(true);
    expect(new Set(manager.list().map((s) => s.id))).toEqual(new Set(["opencode:other", "opencode:new"]));
  });
});

describe("SessionManager approvals", () => {
  async function asking() {
    const ctx = setup();
    await ctx.manager.start({ agent: "opencode", directory: "/repo", title: "Fix it", instructions: "fix" });
    ctx.adapter.emit({
      type: "permission.asked",
      externalId: "new",
      requestId: "req-1",
      action: "edit",
      resources: ["src/app.ts"],
      always: "Allow all edits in this session",
    });
    return ctx;
  }

  test("a request becomes a pending approval, with the agent's always option", async () => {
    const { manager, status } = await asking();
    expect(manager.pendingApprovals()).toMatchObject([
      { action: "edit", tier: "confirm", always: "Allow all edits in this session" },
    ]);
    expect(status("opencode:new")).toBe("needs_you");
  });

  test("a request whose run ended expires, and the session stops needing the user", async () => {
    const { adapter, manager, store, status } = await asking();
    const [approval] = manager.pendingApprovals();
    adapter.emit({ type: "permission.expired", externalId: "new", requestId: "req-1" });
    expect(manager.pendingApprovals()).toEqual([]);
    expect(store.approval(approval?.id as string)?.status).toBe("expired");
    expect(status("opencode:new")).toBe("idle");
  });

  test("answering a request that just expired reports that instead of failing", async () => {
    const { adapter, manager } = await asking();
    const [approval] = manager.pendingApprovals();
    adapter.onReply = async () => {
      adapter.emit({ type: "permission.expired", externalId: "new", requestId: "req-1" });
      throw new Error("no longer waiting");
    };
    expect((await manager.resolveApproval(approval?.id as string, "approve")).status).toBe("expired");
  });

  test("requests that lived in a run of an earlier Mimir are expired on startup", async () => {
    const { adapter, manager, store } = await asking();
    expect(manager.pendingApprovals()).toHaveLength(1);
    // An agent whose requests survive restarts (OpenCode's live on its server) keeps them.
    const agents = new Map<AgentKind, AgentAdapter>([["opencode", adapter]]);
    expect(new SessionManager(agents, store, new EventBus()).pendingApprovals()).toHaveLength(1);
    adapter.approvalsEndWithRun = true;
    expect(new SessionManager(agents, store, new EventBus()).pendingApprovals()).toEqual([]);
  });
});

describe("SessionManager windows", () => {
  test("a session waiting for its user in its own window needs them", async () => {
    const { adapter, manager, status } = setup();
    adapter.recent = [summary("w", { open: true, waitingFor: "permission prompt" })];
    await manager.refresh(true);
    expect(status("opencode:w")).toBe("needs_you");
    expect(manager.get("opencode:w")).toMatchObject({ open: true, waitingFor: "permission prompt" });
  });

  test("a window Mimir messaged is announced when it waits, and clears when it goes on", async () => {
    const { adapter, manager, spoken, status } = setup();
    adapter.recent = [summary("w", { open: true })];
    await manager.refresh(true);
    await manager.message("opencode:w", "go");
    adapter.emit({ type: "waiting", externalId: "w", reason: "permission prompt" });
    expect(status("opencode:w")).toBe("needs_you");
    expect(spoken.at(-1)?.text).toContain("waiting for you in its own window (permission prompt)");
    adapter.emit({ type: "started", externalId: "w" });
    expect(status("opencode:w")).toBe("working");
    expect(manager.get("opencode:w")?.waitingFor).toBeUndefined();
  });
});

describe("SessionManager window state after the fact", () => {
  test("a window that waited, then closed while nobody looked, does not need the user forever", async () => {
    const { adapter, manager, status } = setup();
    adapter.recent = [summary("w", { open: true })];
    await manager.refresh(true);
    await manager.message("opencode:w", "go");
    adapter.emit({ type: "waiting", externalId: "w", reason: "permission prompt" });
    expect(status("opencode:w")).toBe("needs_you");
    // Closed: no longer open, not waiting, nothing pending in Mimir.
    adapter.recent = [summary("w")];
    await manager.refresh(true);
    expect(status("opencode:w")).toBe("idle");
  });

  test("a saved session is not shown as open once it dropped off the live list", async () => {
    const { adapter, manager } = setup();
    adapter.recent = [summary("w", { open: true })];
    await manager.refresh(true);
    manager.focus("opencode:w");
    adapter.recent = [];
    await manager.refresh(true);
    expect(manager.get("opencode:w")?.open).toBeUndefined();
    expect(manager.list().find((s) => s.id === "opencode:w")?.open).toBeUndefined();
  });
});

describe("SessionManager search", () => {
  test("finds sessions outside the recent list and can act on them", async () => {
    const { adapter, manager } = setup();
    adapter.recent = [summary("recent")];
    adapter.archive = [
      summary("old", { title: "Detecting abuse via inbox patterns", updatedAt: Date.now() - 3 * 86_400_000 }),
    ];
    await manager.refresh(true);
    const found = await manager.search({ text: "abuse", limit: 5 });
    expect(found.map((s) => s.title)).toEqual(["Detecting abuse via inbox patterns"]);
    await manager.message("opencode:old", "carry on");
    expect(adapter.prompts).toEqual(["carry on"]);
  });
});
