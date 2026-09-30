/**
 * The contract every coding-agent adapter implements. The core only ever talks
 * to agents through this interface.
 */
import type { AgentKind } from "@openmimir/protocol";
import type { SessionQuery } from "./util.ts";

export type { SessionQuery };

export type PermissionDecision = "once" | "always" | "reject";

export type AdapterEvent =
  | { type: "started"; externalId: string }
  | { type: "text"; externalId: string; text: string }
  | { type: "succeeded"; externalId: string }
  | { type: "failed"; externalId: string; error: string }
  | { type: "interrupted"; externalId: string; reason: string }
  | {
      type: "permission.asked";
      externalId: string;
      requestId: string;
      action: string;
      resources: string[];
      message?: string;
    }
  | {
      type: "permission.replied";
      externalId: string;
      requestId: string;
      decision: PermissionDecision;
    };

export interface FileChange {
  file: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch: string;
}

export interface AdapterHealth {
  ok: boolean;
  /** True when something answered, even if with an error. */
  answered?: boolean;
  version?: string;
  error?: string;
}

/** A session found in the agent's own history, whoever started it. */
export interface SessionSummary {
  externalId: string;
  title: string;
  directory: string;
  updatedAt: number;
  createdAt: number;
  /** True if the agent is known to be working on it right now. */
  running: boolean;
  lastText?: string;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Whether the agent can pause for approvals that Mimir answers. */
  readonly supportsApprovals: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<AdapterHealth>;
  /** Most recently active sessions, newest first. */
  listRecent(limit: number): Promise<SessionSummary[]>;
  /** Search the agent's whole history, best matches first. */
  search(query: SessionQuery): Promise<SessionSummary[]>;
  /** Create a session in `directory` and send it its first instructions. */
  createSession(input: {
    directory: string;
    title: string;
    prompt: string;
    /** Shell command globs that must never run without the user's approval. */
    guardedCommands: string[];
  }): Promise<{ externalId: string }>;
  prompt(
    session: { externalId: string; directory: string },
    text: string,
    guardedCommands: string[],
  ): Promise<void>;
  interrupt(externalId: string): Promise<void>;
  lastAssistantText(session: { externalId: string; directory: string }): Promise<string | undefined>;
  diff(session: { externalId: string; directory: string }): Promise<FileChange[]>;
  replyPermission(externalId: string, requestId: string, decision: PermissionDecision): Promise<void>;
  onEvent(listener: (event: AdapterEvent) => void): () => void;
}
