import type { AdapterEvent, AgentAdapter, FileChange, SessionSummary } from "@openmimir/adapters";
import {
  AGENT_LABELS,
  type AgentKind,
  type AgentSession,
  type Approval,
  type ApprovalDecision,
  describeAction,
  type SessionStatus,
  sessionKey,
} from "@openmimir/protocol";
import { type EventBus, newId } from "./bus.ts";
import { classifyApproval, GUARDED_SHELL_COMMANDS } from "./policy.ts";
import type { Store } from "./store.ts";

export interface Announcement {
  kind: "started" | "finished" | "failed" | "approval" | "stopped";
  sessionId: string;
  /** Short, speakable summary. */
  text: string;
  /** For "finished": the agent's full final reply, so the foreman can report on it. */
  result?: string;
}

const TEXT_PREVIEW = 600;
/** Recent sessions from all agents are refreshed this often. */
const RECENT_TTL_MS = 5_000;
const RECENT_PER_AGENT = 8;
/** Sessions touched this recently outside Mimir are probably open on the user's screen. */
export const IN_USE_MS = 3 * 60_000;

/**
 * Mimir is the master thread above every coding-agent session. It tracks the
 * sessions it started or continued, and knows about recent sessions in every
 * agent so the user can pick up any of them without naming an agent or a session.
 */
export class SessionManager {
  private readonly announcers = new Set<(a: Announcement) => void>();
  private readonly lastRejection = new Map<string, number>();
  private recentCache: { at: number; sessions: AgentSession[] } | undefined;
  private refreshing: Promise<AgentSession[]> | undefined;
  private lastPublished = "";
  /** Sessions found by search, so the foreman can act on them by id. */
  private readonly found = new Map<string, AgentSession>();

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

  /** Tracked sessions plus recent sessions from every agent, newest first. */
  list(): AgentSession[] {
    // Freshly listed sessions already carry Mimir's stored state (see fromSummary), so they
    // win; stored sessions only fill in ones that dropped off the agents' recent lists.
    const merged = new Map<string, AgentSession>();
    for (const session of this.store.sessions(40)) merged.set(session.id, session);
    for (const session of this.recentCache?.sessions ?? []) merged.set(session.id, session);
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): AgentSession | undefined {
    return (
      this.recentCache?.sessions.find((t) => t.id === id) ?? this.store.session(id) ?? this.found.get(id)
    );
  }

  /** Search every agent's whole history, not just the recent sessions. */
  async search(query: { text?: string; project?: string; limit: number }): Promise<AgentSession[]> {
    const results = await Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        try {
          return (await adapter.search(query)).map((s) => this.fromSummary(adapter.kind, s));
        } catch (error) {
          this.log(
            `[sessions] could not search ${adapter.kind}: ${error instanceof Error ? error.message : error}`,
          );
          return [];
        }
      }),
    );
    // Interleave agents so one agent's many weak matches do not crowd out another's.
    const merged: AgentSession[] = [];
    for (let i = 0; merged.length < query.limit && results.some((r) => i < r.length); i++) {
      for (const list of results) if (list[i]) merged.push(list[i] as AgentSession);
    }
    for (const session of merged) this.found.set(session.id, session);
    return merged.slice(0, query.limit);
  }

  pendingApprovals(): Approval[] {
    return this.store.pendingApprovals();
  }

  /** Refresh the list of recent sessions from all agents (cached briefly). */
  async refresh(force = false): Promise<AgentSession[]> {
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
              `[sessions] could not list ${adapter.kind} sessions: ${error instanceof Error ? error.message : error}`,
            );
            return [];
          }
        }),
      );
      this.recentCache = { at: Date.now(), sessions: results.flat() };
      const sessions = this.list();
      // Refreshes run every few seconds; only tell interfaces when something changed.
      const fingerprint = JSON.stringify(sessions);
      if (fingerprint !== this.lastPublished) {
        this.lastPublished = fingerprint;
        this.bus.publish({ type: "sessions.replace", sessions });
      }
      return sessions;
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private fromSummary(agent: AgentKind, s: SessionSummary): AgentSession {
    const id = sessionKey(agent, s.externalId);
    const tracked = this.store.session(id);
    if (tracked && !tracked.tracked) {
      // Mimir only looked at it: everything but focusedAt comes from the agent.
      return { ...this.external(id, agent, s), focusedAt: tracked.focusedAt };
    }
    if (tracked) {
      // Keep Mimir's own state, but take fresher details from the agent. The user may
      // also be running it from their own window, which Mimir only sees by inference.
      const quietFor = Date.now() - Math.max(tracked.updatedAt, s.updatedAt);
      const status =
        s.running && tracked.status !== "needs_you"
          ? "working"
          : !s.running && tracked.status === "working" && quietFor > 30_000
            ? "idle"
            : tracked.status;
      return {
        ...tracked,
        status,
        title: tracked.origin === "mimir" ? tracked.title : s.title,
        updatedAt: Math.max(tracked.updatedAt, s.updatedAt),
        lastText: s.lastText?.slice(-TEXT_PREVIEW) ?? tracked.lastText,
      };
    }
    return this.external(id, agent, s);
  }

  private external(id: string, agent: AgentKind, s: SessionSummary): AgentSession {
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

  /** Remember that the foreman looked at a session, so interfaces can show it. */
  focus(id: string): AgentSession | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    const next = { ...session, focusedAt: Date.now() };
    this.store.saveSession(next);
    this.bus.publish({ type: "session.upsert", session: next });
    return next;
  }

  private save(session: AgentSession, patch: Partial<AgentSession> = {}): AgentSession {
    const next = { ...session, ...patch, updatedAt: Date.now() };
    this.store.saveSession(next);
    // Keep the cached list in step, or the next refresh would publish the old status.
    if (this.recentCache) {
      this.recentCache.sessions = this.recentCache.sessions.map((s) => (s.id === next.id ? next : s));
    }
    this.bus.publish({ type: "session.upsert", session: next });
    return next;
  }

  async start(input: {
    agent: AgentKind;
    directory: string;
    title: string;
    instructions: string;
  }): Promise<AgentSession> {
    const { externalId } = await this.adapter(input.agent).createSession({
      directory: input.directory,
      title: input.title,
      prompt: input.instructions,
      guardedCommands: GUARDED_SHELL_COMMANDS,
    });
    const now = Date.now();
    const session = this.save({
      id: sessionKey(input.agent, externalId),
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
    this.announce({ kind: "started", sessionId: session.id, text: `Started "${session.title}".` });
    return session;
  }

  /** Send a message to any session, including sessions started outside Mimir. */
  async message(id: string, text: string): Promise<AgentSession> {
    const session = this.require(id);
    await this.adapter(session.agent).prompt(session, text, GUARDED_SHELL_COMMANDS);
    return this.save(session, { status: "working", error: undefined, tracked: true });
  }

  async stop(id: string): Promise<AgentSession> {
    const session = this.require(id);
    await this.adapter(session.agent).interrupt(session.externalId);
    return this.save(session, { status: "idle" });
  }

  async latestText(id: string): Promise<string | undefined> {
    const session = this.require(id);
    return (
      (await this.adapter(session.agent)
        .lastAssistantText(session)
        .catch(() => undefined)) ?? session.lastText
    );
  }

  async changes(id: string): Promise<FileChange[]> {
    const session = this.require(id);
    return this.adapter(session.agent).diff(session);
  }

  async resolveApproval(id: string, decision: ApprovalDecision): Promise<Approval> {
    const approval = this.store.approval(id);
    if (!approval) throw new Error(`No approval with id ${id}`);
    if (approval.status !== "pending") return approval;
    const session = this.require(approval.sessionId);
    await this.adapter(session.agent).replyPermission(
      session.externalId,
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
    if (decision === "reject") this.lastRejection.set(session.id, Date.now());
    if (!this.hasPending(session.id) && session.status === "needs_you")
      this.save(session, { status: "working" });
    return next;
  }

  private require(id: string): AgentSession {
    const session = this.get(id);
    if (!session) throw new Error(`No session with id ${id}. Use recent_sessions to see what exists.`);
    return session;
  }

  private hasPending(id: string) {
    return this.store.pendingApprovals().some((a) => a.sessionId === id);
  }

  private handle(agent: AgentKind, event: AdapterEvent) {
    const session = this.store.session(sessionKey(agent, event.externalId));
    // Sessions Mimir never drove are only shown, not narrated.
    if (!session?.tracked) return;
    switch (event.type) {
      case "started":
        this.save(session, { status: "working", error: undefined });
        break;
      case "text":
        this.save(session, { lastText: event.text.slice(-TEXT_PREVIEW) });
        break;
      case "succeeded": {
        const next = this.save(session, { status: this.hasPending(session.id) ? "needs_you" : "idle" });
        // lastText is only a preview; fetch the whole reply so the foreman can report on it.
        void this.adapter(session.agent)
          .lastAssistantText(session)
          .catch(() => undefined)
          .then((result) =>
            this.announce({
              kind: "finished",
              sessionId: session.id,
              text: `"${session.title}" finished. ${summarize(result ?? next.lastText)}`,
              result: result ?? next.lastText,
            }),
          );
        break;
      }
      case "failed":
        this.save(session, { status: "failed", error: event.error });
        this.announce({
          kind: "failed",
          sessionId: session.id,
          text: `"${session.title}" failed: ${event.error.slice(0, 200)}`,
        });
        break;
      case "interrupted": {
        this.save(session, { status: "idle" });
        const rejectedAt = this.lastRejection.get(session.id) ?? 0;
        if (Date.now() - rejectedAt < 60_000) {
          this.announce({
            kind: "stopped",
            sessionId: session.id,
            text: `"${session.title}" stopped after its request was rejected.`,
          });
        } else if (event.reason !== "user") {
          this.announce({
            kind: "stopped",
            sessionId: session.id,
            text: `"${session.title}" stopped (${event.reason}).`,
          });
        }
        break;
      }
      case "permission.asked": {
        const tier = classifyApproval(event.action, event.resources);
        const approval: Approval = {
          id: newId("apr"),
          sessionId: session.id,
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
        this.save(session, { status: "needs_you" });
        const what = describeAction(event.action, event.resources);
        this.announce({
          kind: "approval",
          sessionId: session.id,
          text:
            tier === "screen"
              ? `"${session.title}" wants to ${what}. That needs approval on a screen.`
              : `"${session.title}" asks permission to ${what}. The user can approve or reject by voice.`,
        });
        break;
      }
      case "permission.replied": {
        const approval = this.store
          .pendingApprovals()
          .find((a) => a.sessionId === session.id && a.externalId === event.requestId);
        if (approval) {
          const next: Approval = {
            ...approval,
            status: event.decision === "reject" ? "rejected" : "approved",
            resolvedAt: Date.now(),
          };
          this.store.saveApproval(next);
          this.bus.publish({ type: "approval.upsert", approval: next });
          if (!this.hasPending(session.id) && session.status === "needs_you")
            this.save(session, { status: "working" });
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

export function statusLabel(status: SessionStatus): string {
  return { working: "running", needs_you: "needs you", failed: "failed", idle: "idle" }[status];
}

export function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
