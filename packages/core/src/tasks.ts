import type { AdapterEvent, AgentAdapter, FileChange, SessionSummary } from "@openmimir/adapters";
import {
  AGENT_LABELS,
  type AgentKind,
  type Approval,
  type ApprovalDecision,
  describeAction,
  type Task,
  type TaskStatus,
  taskId,
} from "@openmimir/protocol";
import { type EventBus, newId } from "./bus.ts";
import { classifyApproval, GUARDED_SHELL_COMMANDS } from "./policy.ts";
import type { Store } from "./store.ts";

export interface Announcement {
  kind: "started" | "done" | "failed" | "approval" | "stopped";
  taskId: string;
  /** Short, speakable summary. */
  text: string;
}

const TEXT_PREVIEW = 600;
/** Recent sessions from all agents are refreshed this often. */
const RECENT_TTL_MS = 20_000;
const RECENT_PER_AGENT = 8;
/** Sessions touched this recently outside Mimir are probably open on the user's screen. */
export const IN_USE_MS = 3 * 60_000;

/**
 * Every coding-agent session is a task. Mimir tracks the ones it started or
 * continued, and knows about recent sessions in every agent so the user can
 * pick up any of them without naming an agent or a session.
 */
export class TaskManager {
  private readonly announcers = new Set<(a: Announcement) => void>();
  private readonly lastRejection = new Map<string, number>();
  private recentCache: { at: number; tasks: Task[] } | undefined;
  private refreshing: Promise<Task[]> | undefined;

  constructor(
    private readonly adapters: Map<AgentKind, AgentAdapter>,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    for (const adapter of adapters.values()) {
      adapter.onEvent((event) => this.handle(adapter.kind, event));
    }
  }

  get agents(): AgentKind[] {
    return [...this.adapters.keys()];
  }

  onAnnouncement(listener: (a: Announcement) => void): () => void {
    this.announcers.add(listener);
    return () => this.announcers.delete(listener);
  }

  private announce(a: Announcement) {
    for (const listener of this.announcers) listener(a);
  }

  private adapter(agent: AgentKind): AgentAdapter {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`${AGENT_LABELS[agent]} is not available.`);
    return adapter;
  }

  /** Tracked tasks plus recent sessions from every agent, newest first. */
  list(): Task[] {
    const merged = new Map<string, Task>();
    for (const task of this.recentCache?.tasks ?? []) merged.set(task.id, task);
    for (const task of this.store.tasks(40)) merged.set(task.id, task);
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Task | undefined {
    return this.store.task(id) ?? this.recentCache?.tasks.find((t) => t.id === id);
  }

  pendingApprovals(): Approval[] {
    return this.store.pendingApprovals();
  }

  /** Refresh the list of recent sessions from all agents (cached briefly). */
  async refresh(force = false): Promise<Task[]> {
    if (!force && this.recentCache && Date.now() - this.recentCache.at < RECENT_TTL_MS) {
      return this.list();
    }
    this.refreshing ??= (async () => {
      const results = await Promise.all(
        [...this.adapters.values()].map(async (adapter) => {
          try {
            return (await adapter.listRecent(RECENT_PER_AGENT)).map((s) => this.fromSummary(adapter.kind, s));
          } catch (error) {
            this.log(
              `[tasks] could not list ${adapter.kind} sessions: ${error instanceof Error ? error.message : error}`,
            );
            return [];
          }
        }),
      );
      this.recentCache = { at: Date.now(), tasks: results.flat() };
      const tasks = this.list();
      this.bus.publish({ type: "tasks.replace", tasks });
      return tasks;
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private fromSummary(agent: AgentKind, s: SessionSummary): Task {
    const id = taskId(agent, s.externalId);
    const tracked = this.store.task(id);
    if (tracked) {
      // Keep Mimir's own state, but take fresher details from the agent.
      return { ...tracked, lastText: s.lastText?.slice(-TEXT_PREVIEW) ?? tracked.lastText };
    }
    return {
      id,
      agent,
      title: s.title,
      directory: s.directory,
      status: s.running ? "working" : "idle",
      externalId: s.externalId,
      origin: "external",
      tracked: false,
      lastText: s.lastText?.slice(-TEXT_PREVIEW),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  private save(task: Task, patch: Partial<Task> = {}): Task {
    const next = { ...task, ...patch, updatedAt: Date.now() };
    this.store.saveTask(next);
    this.bus.publish({ type: "task.upsert", task: next });
    return next;
  }

  async start(input: {
    agent: AgentKind;
    directory: string;
    title: string;
    instructions: string;
  }): Promise<Task> {
    const { externalId } = await this.adapter(input.agent).createSession({
      directory: input.directory,
      title: input.title,
      prompt: input.instructions,
      guardedCommands: GUARDED_SHELL_COMMANDS,
    });
    const now = Date.now();
    const task = this.save({
      id: taskId(input.agent, externalId),
      agent: input.agent,
      title: input.title,
      directory: input.directory,
      status: "working",
      externalId,
      origin: "mimir",
      tracked: true,
      createdAt: now,
      updatedAt: now,
    });
    this.announce({ kind: "started", taskId: task.id, text: `Started "${task.title}".` });
    return task;
  }

  /** Send a message to any task, including sessions started outside Mimir. */
  async message(id: string, text: string): Promise<Task> {
    const task = this.require(id);
    await this.adapter(task.agent).prompt(task, text, GUARDED_SHELL_COMMANDS);
    return this.save(task, { status: "working", error: undefined, tracked: true });
  }

  async stop(id: string): Promise<Task> {
    const task = this.require(id);
    await this.adapter(task.agent).interrupt(task.externalId);
    return this.save(task, { status: "idle" });
  }

  async latestText(id: string): Promise<string | undefined> {
    const task = this.require(id);
    return (
      (await this.adapter(task.agent)
        .lastAssistantText(task)
        .catch(() => undefined)) ?? task.lastText
    );
  }

  async changes(id: string): Promise<FileChange[]> {
    const task = this.require(id);
    return this.adapter(task.agent).diff(task);
  }

  async resolveApproval(id: string, decision: ApprovalDecision): Promise<Approval> {
    const approval = this.store.approval(id);
    if (!approval) throw new Error(`No approval with id ${id}`);
    if (approval.status !== "pending") return approval;
    const task = this.require(approval.taskId);
    await this.adapter(task.agent).replyPermission(
      task.externalId,
      approval.externalId,
      decision === "approve" ? "once" : decision === "approve_always" ? "always" : "reject",
    );
    const next: Approval = {
      ...approval,
      status: decision === "reject" ? "rejected" : "approved",
      resolvedAt: Date.now(),
    };
    this.store.saveApproval(next);
    this.bus.publish({ type: "approval.upsert", approval: next });
    if (decision === "reject") this.lastRejection.set(task.id, Date.now());
    if (!this.hasPending(task.id) && task.status === "needs_you") this.save(task, { status: "working" });
    return next;
  }

  private require(id: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`No task with id ${id}. Use recent_tasks to see what exists.`);
    return task;
  }

  private hasPending(id: string) {
    return this.store.pendingApprovals().some((a) => a.taskId === id);
  }

  private handle(agent: AgentKind, event: AdapterEvent) {
    const task = this.store.task(taskId(agent, event.externalId));
    // Sessions Mimir never touched are only shown, not narrated.
    if (!task) return;
    switch (event.type) {
      case "started":
        this.save(task, { status: "working", error: undefined });
        break;
      case "text":
        this.save(task, { lastText: event.text.slice(-TEXT_PREVIEW) });
        break;
      case "succeeded": {
        const next = this.save(task, { status: this.hasPending(task.id) ? "needs_you" : "done" });
        this.announce({
          kind: "done",
          taskId: task.id,
          text: `"${task.title}" is done. ${summarize(next.lastText)}`,
        });
        break;
      }
      case "failed":
        this.save(task, { status: "failed", error: event.error });
        this.announce({
          kind: "failed",
          taskId: task.id,
          text: `"${task.title}" failed: ${event.error.slice(0, 200)}`,
        });
        break;
      case "interrupted": {
        this.save(task, { status: "idle" });
        const rejectedAt = this.lastRejection.get(task.id) ?? 0;
        if (Date.now() - rejectedAt < 60_000) {
          this.announce({
            kind: "stopped",
            taskId: task.id,
            text: `"${task.title}" stopped after its request was rejected.`,
          });
        } else if (event.reason !== "user") {
          this.announce({
            kind: "stopped",
            taskId: task.id,
            text: `"${task.title}" stopped (${event.reason}).`,
          });
        }
        break;
      }
      case "permission.asked": {
        const tier = classifyApproval(event.action, event.resources);
        const approval: Approval = {
          id: newId("apr"),
          taskId: task.id,
          externalId: event.requestId,
          action: event.action,
          resources: event.resources,
          message: event.message,
          tier,
          status: "pending",
          createdAt: Date.now(),
        };
        this.store.saveApproval(approval);
        this.bus.publish({ type: "approval.upsert", approval });
        this.save(task, { status: "needs_you" });
        const what = describeAction(event.action, event.resources);
        this.announce({
          kind: "approval",
          taskId: task.id,
          text:
            tier === "screen"
              ? `"${task.title}" wants to ${what}. That needs approval on a screen.`
              : `"${task.title}" asks permission to ${what}. The user can approve or reject by voice.`,
        });
        break;
      }
      case "permission.replied": {
        const approval = this.store
          .pendingApprovals()
          .find((a) => a.taskId === task.id && a.externalId === event.requestId);
        if (approval) {
          const next: Approval = {
            ...approval,
            status: event.decision === "reject" ? "rejected" : "approved",
            resolvedAt: Date.now(),
          };
          this.store.saveApproval(next);
          this.bus.publish({ type: "approval.upsert", approval: next });
          if (!this.hasPending(task.id) && task.status === "needs_you")
            this.save(task, { status: "working" });
        }
        break;
      }
    }
  }
}

function summarize(text: string | undefined): string {
  if (!text) return "";
  const clean = text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

export function statusLabel(status: TaskStatus): string {
  return { working: "working", needs_you: "needs you", done: "done", failed: "failed", idle: "idle" }[status];
}

export function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
