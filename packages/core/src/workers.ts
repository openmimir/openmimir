import type { AdapterEvent, AgentAdapter, FileChange } from "@openmimir/adapters";
import {
  type Approval,
  type ApprovalDecision,
  describeAction,
  type Worker,
  type WorkerStatus,
} from "@openmimir/protocol";
import { type EventBus, newId } from "./bus.ts";
import { classifyApproval, GUARDED_SHELL_COMMANDS } from "./policy.ts";
import type { Store } from "./store.ts";

export interface Announcement {
  kind: "done" | "failed" | "approval" | "stopped";
  workerId: string;
  /** Short, speakable summary. */
  text: string;
}

const TEXT_PREVIEW = 600;

/** Tracks every worker agent session and turns adapter events into state. */
export class WorkerManager {
  private readonly announcers = new Set<(a: Announcement) => void>();
  private readonly lastRejection = new Map<string, number>();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {
    adapter.onEvent((event) => this.handle(event));
  }

  onAnnouncement(listener: (a: Announcement) => void): () => void {
    this.announcers.add(listener);
    return () => this.announcers.delete(listener);
  }

  private announce(a: Announcement) {
    for (const listener of this.announcers) listener(a);
  }

  list(): Worker[] {
    return this.store.workers();
  }

  get(id: string): Worker | undefined {
    return this.store.worker(id);
  }

  pendingApprovals(): Approval[] {
    return this.store.pendingApprovals();
  }

  private update(worker: Worker, patch: Partial<Worker>): Worker {
    const next = { ...worker, ...patch, updatedAt: Date.now() };
    this.store.saveWorker(next);
    this.bus.publish({ type: "worker.upsert", worker: next });
    return next;
  }

  async start(input: { directory: string; title: string; instructions: string }): Promise<Worker> {
    const { externalId } = await this.adapter.createSession({
      directory: input.directory,
      title: input.title,
      guardedCommands: GUARDED_SHELL_COMMANDS,
    });
    const now = Date.now();
    const worker: Worker = {
      id: newId("wrk"),
      agent: "opencode",
      title: input.title,
      directory: input.directory,
      status: "working",
      externalId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveWorker(worker);
    this.bus.publish({ type: "worker.upsert", worker });
    await this.adapter.prompt(externalId, input.instructions);
    return worker;
  }

  async message(id: string, text: string): Promise<Worker> {
    const worker = this.require(id);
    await this.adapter.prompt(worker.externalId, text);
    return this.update(worker, { status: "working", error: undefined });
  }

  async stop(id: string): Promise<Worker> {
    const worker = this.require(id);
    await this.adapter.interrupt(worker.externalId);
    return this.update(worker, { status: "idle" });
  }

  async latestText(id: string): Promise<string | undefined> {
    const worker = this.require(id);
    return (await this.adapter.lastAssistantText(worker.externalId)) ?? worker.lastText;
  }

  async changes(id: string): Promise<FileChange[]> {
    return this.adapter.diff(this.require(id).externalId);
  }

  async resolveApproval(id: string, decision: ApprovalDecision): Promise<Approval> {
    const approval = this.store.approval(id);
    if (!approval) throw new Error(`No approval with id ${id}`);
    if (approval.status !== "pending") return approval;
    const worker = this.require(approval.workerId);
    await this.adapter.replyPermission(
      worker.externalId,
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
    if (decision === "reject") this.lastRejection.set(worker.id, Date.now());
    const stillWaiting = this.store.pendingApprovals().some((a) => a.workerId === worker.id);
    if (!stillWaiting && worker.status === "needs_you") this.update(worker, { status: "working" });
    return next;
  }

  private require(id: string): Worker {
    const worker = this.store.worker(id);
    if (!worker) throw new Error(`No worker with id ${id}`);
    return worker;
  }

  private handle(event: AdapterEvent) {
    const worker = this.store.workerByExternalId(event.externalId);
    // Only track sessions Mimir started; the user's own OpenCode sessions are left alone.
    if (!worker) return;
    switch (event.type) {
      case "started":
        this.update(worker, { status: "working", error: undefined });
        break;
      case "text":
        this.update(worker, { lastText: event.text.slice(-TEXT_PREVIEW) });
        break;
      case "succeeded": {
        const next = this.update(worker, { status: this.hasPending(worker.id) ? "needs_you" : "done" });
        this.announce({
          kind: "done",
          workerId: worker.id,
          text: `Worker "${worker.title}" finished. ${summarize(next.lastText)}`,
        });
        break;
      }
      case "failed":
        this.update(worker, { status: "failed", error: event.error });
        this.announce({
          kind: "failed",
          workerId: worker.id,
          text: `Worker "${worker.title}" failed: ${event.error.slice(0, 200)}`,
        });
        break;
      case "interrupted": {
        this.update(worker, { status: "idle" });
        const rejectedAt = this.lastRejection.get(worker.id) ?? 0;
        if (Date.now() - rejectedAt < 60_000) {
          this.announce({
            kind: "stopped",
            workerId: worker.id,
            text: `Worker "${worker.title}" stopped after its request was rejected.`,
          });
        } else if (event.reason !== "user") {
          this.announce({
            kind: "stopped",
            workerId: worker.id,
            text: `Worker "${worker.title}" stopped (${event.reason}).`,
          });
        }
        break;
      }
      case "permission.asked": {
        const tier = classifyApproval(event.action, event.resources);
        const approval: Approval = {
          id: newId("apr"),
          workerId: worker.id,
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
        this.update(worker, { status: "needs_you" });
        const what = describeAction(event.action, event.resources);
        this.announce({
          kind: "approval",
          workerId: worker.id,
          text:
            tier === "screen"
              ? `Worker "${worker.title}" wants to ${what}. That needs approval on a screen.`
              : `Worker "${worker.title}" asks permission to ${what}. The user can approve or reject by voice.`,
        });
        break;
      }
      case "permission.replied": {
        const approval = this.store
          .pendingApprovals()
          .find((a) => a.workerId === worker.id && a.externalId === event.requestId);
        if (approval) {
          // Answered somewhere else, e.g. directly in OpenCode.
          const next: Approval = {
            ...approval,
            status: event.decision === "reject" ? "rejected" : "approved",
            resolvedAt: Date.now(),
          };
          this.store.saveApproval(next);
          this.bus.publish({ type: "approval.upsert", approval: next });
          if (!this.hasPending(worker.id) && worker.status === "needs_you") {
            this.update(worker, { status: "working" });
          }
        }
        break;
      }
    }
  }

  private hasPending(workerId: string) {
    return this.store.pendingApprovals().some((a) => a.workerId === workerId);
  }
}

function summarize(text: string | undefined): string {
  if (!text) return "";
  const clean = text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

export function statusLabel(status: WorkerStatus): string {
  return {
    working: "working",
    needs_you: "needs you",
    done: "done",
    failed: "failed",
    idle: "idle",
  }[status];
}
