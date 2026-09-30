/**
 * Shared types between the Mimir server and every interface (web UI, trainer
 * screen, future desktop app). Keep this package free of runtime dependencies.
 */

export type MessageRole = "user" | "assistant" | "notice";
export type MessageSource = "text" | "voice" | "system";

/** One thing the foreman did while answering, shown inline in the conversation. */
export interface ForemanStep {
  id: string;
  /** Short human label, e.g. `Checked "Prod warnings and errors analysis"`. */
  label: string;
  /** The session this step read or changed, if any. */
  sessionId?: string;
  state: "running" | "done" | "error";
  /** What Mimir sent to the session, shown in full so nothing happens behind the user's back. */
  message?: string;
  /** Extra detail, e.g. how many results or an error. */
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  source: MessageSource;
  text: string;
  /** True while the foreman is still streaming this message. */
  pending?: boolean;
  /** What the foreman did while producing this reply. */
  steps?: ForemanStep[];
  /** Set on notices about a session, so interfaces can show its live status. */
  sessionId?: string;
  createdAt: number;
}

export type AgentKind = "opencode" | "claude" | "codex";

export const AGENT_LABELS: Record<AgentKind, string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * `idle` means not running: its last turn is over, whoever started it. What a
 * finished turn produced is reported in the conversation, not as a status.
 */
export type SessionStatus = "working" | "needs_you" | "failed" | "idle";

/**
 * One coding-agent session. Mimir tracks sessions it started, sessions the
 * user asked it to continue, and shows recent sessions from every agent.
 */
export interface AgentSession {
  /** `${agent}:${externalId}`, stable across restarts and agents. */
  id: string;
  agent: AgentKind;
  title: string;
  directory: string;
  status: SessionStatus;
  /** The agent's own session id. */
  externalId: string;
  /** "mimir" if Mimir started it, "external" if it was started elsewhere. */
  origin: "mimir" | "external";
  /** True once Mimir has started or messaged it; only these get spoken updates. */
  tracked: boolean;
  /** When the foreman last looked at or acted on it. */
  focusedAt?: number;
  /** Last thing the agent said, trimmed for display. */
  lastText?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export function sessionKey(agent: AgentKind, externalId: string): string {
  return `${agent}:${externalId}`;
}

/**
 * How dangerous an action is. Decides where it may be approved:
 * - `auto`: runs without asking (reads, searches, tests)
 * - `confirm`: may be approved by voice with an explicit spoken confirmation
 * - `screen`: must be approved on a screen (push, deploy, delete, ...)
 */
export type RiskTier = "auto" | "confirm" | "screen";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  sessionId: string;
  /** The agent's own request id, e.g. an OpenCode `per_...` id. */
  externalId: string;
  action: string;
  resources: string[];
  message?: string;
  tier: RiskTier;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
}

export type ApprovalDecision = "approve" | "approve_always" | "reject";

export type VoiceStatus = "off" | "connecting" | "live" | "error";

export interface VoiceState {
  status: VoiceStatus;
  sessionId?: string;
  /** Who is currently producing audio, as far as the server can tell. */
  speaking?: "user" | "mimir" | null;
  /** True while the foreman is working on a delegated voice request. */
  thinking?: boolean;
  seconds?: number;
  error?: string;
}

export interface Caption {
  speaker: "user" | "mimir";
  text: string;
  /** False while the turn is still growing. */
  final: boolean;
  at: number;
}

export interface ProjectRef {
  name: string;
  directory: string;
}

export interface ServerInfo {
  version: string;
  foremanModel: string;
  voiceModel: string;
  voiceConfigured: boolean;
  agents: Array<{ kind: AgentKind; available: boolean; detail?: string }>;
  projects: ProjectRef[];
}

export interface Snapshot {
  info: ServerInfo;
  messages: ChatMessage[];
  sessions: AgentSession[];
  approvals: Approval[];
  voice: VoiceState;
}

/** Events pushed from the server to every connected interface. */
export type ServerEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "message.upsert"; message: ChatMessage }
  | { type: "session.upsert"; session: AgentSession }
  | { type: "sessions.replace"; sessions: AgentSession[] }
  | { type: "approval.upsert"; approval: Approval }
  | { type: "voice.state"; voice: VoiceState }
  | { type: "caption"; caption: Caption }
  | { type: "info"; info: ServerInfo };

/** Human wording for an approval, e.g. "run git push origin main". */
export function describeAction(action: string, resources: string[]): string {
  const target = resources.slice(0, 2).join(", ");
  const verb =
    {
      shell: "run",
      bash: "run",
      edit: "edit",
      write: "write",
      read: "read",
      external_directory: "access files outside the project:",
      webfetch: "fetch",
    }[action] ?? action;
  return target ? `${verb} ${target}` : verb;
}
