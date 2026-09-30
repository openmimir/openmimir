/**
 * The contract every coding-agent adapter implements. The foreman only ever
 * talks to agents through this interface, so adding Claude Code or Codex later
 * means writing one new adapter, not touching the core.
 */

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
  /** True when something answered at the URL, even if with an error. */
  answered?: boolean;
  version?: string;
  error?: string;
}

export interface AgentAdapter {
  readonly kind: string;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<AdapterHealth>;
  createSession(input: {
    directory: string;
    title: string;
    /** Shell command globs that must always ask for approval in this session. */
    guardedCommands?: string[];
  }): Promise<{ externalId: string }>;
  prompt(externalId: string, text: string): Promise<void>;
  interrupt(externalId: string): Promise<void>;
  lastAssistantText(externalId: string): Promise<string | undefined>;
  diff(externalId: string): Promise<FileChange[]>;
  replyPermission(externalId: string, requestId: string, decision: PermissionDecision): Promise<void>;
  onEvent(listener: (event: AdapterEvent) => void): () => void;
}
