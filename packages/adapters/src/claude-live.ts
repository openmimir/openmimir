import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * Claude Code sessions running right now, wherever they are open: a terminal, an IDE
 * such as Orca, the Claude desktop app, agent view, or a tool built on Claude's SDK.
 * Claude Code registers each one in
 * `<config>/sessions/<pid>.json`, with an inbox for cross-session messages
 * (https://code.claude.com/docs/en/cross-session-messaging). A message posted to the
 * inbox shows up in that window and starts a turn there, as one from another Claude
 * Code session would; the window's own permission prompts still apply.
 */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  /** "busy", "waiting" or "idle". */
  status?: string;
  /** What a waiting session waits for, e.g. "permission prompt". */
  waitingFor?: string;
  /** Run through Claude's SDK (`claude -p`, other tools, Mimir's own runs) rather than in a terminal. */
  headless: boolean;
  /** Its inbox: a Unix socket, or a named pipe on Windows. Absent if it can't take messages. */
  inbox?: string;
  /** Authenticates a sender as the same OS user; Windows requires it. */
  token?: string;
  updatedAt: number;
}

/** The inbox protocol this code speaks (`peerProtocol` in the registry). */
const PEER_PROTOCOL = 1;
/** The name the receiving window shows: "Message from @OpenMimir". */
export const SENDER_NAME = "OpenMimir";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Live sessions from Claude Code's registry in `configDir` (e.g. ~/.claude). */
export function readLiveSessions(
  configDir: string,
  alive: (pid: number) => boolean = isAlive,
): LiveSession[] {
  const dir = join(configDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: LiveSession[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pid = Number(match[1]);
    const sessionId = text(entry.sessionId);
    const cwd = text(entry.cwd);
    // A crashed session leaves its file behind.
    if (!sessionId || !cwd || !alive(pid)) continue;
    const keyFile = names.find((n) => n.startsWith(`${pid}.`) && n.endsWith(".key"));
    sessions.push({
      pid,
      sessionId,
      cwd,
      name: text(entry.name),
      status: text(entry.status),
      waitingFor: text(entry.waitingFor),
      headless: text(entry.entrypoint)?.startsWith("sdk") ?? false,
      inbox: entry.peerProtocol === PEER_PROTOCOL ? text(entry.messagingSocketPath) : undefined,
      token: keyFile ? readToken(join(dir, keyFile)) : undefined,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    });
  }
  return sessions;
}

/**
 * Sessions open somewhere other than Mimir, by session id. Mimir's own headless runs
 * (`own`) register too, but aren't open anywhere. A conversation open twice (resumed in a
 * second window) maps to the one that changed last.
 */
export function openWindows(sessions: LiveSession[], own: Set<string> = new Set()): Map<string, LiveSession> {
  const windows = new Map<string, LiveSession>();
  for (const session of sessions) {
    if (session.headless && own.has(session.sessionId)) continue;
    const other = windows.get(session.sessionId);
    if (!other || other.updatedAt < session.updatedAt) windows.set(session.sessionId, session);
  }
  return windows;
}

function readToken(file: string): string | undefined {
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { peerToken?: unknown }).peerToken;
    return typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A message in the form Claude Code reads a sender's name from. `from-mode` says Mimir is
 * not a session that skips permission prompts, so a window that does skip them asks its
 * user before taking the message.
 */
export function envelope(body: string, from = SENDER_NAME): string {
  const safe = body.replaceAll("</cross-session-message>", "</cross-session-message >");
  return `<cross-session-message from-name="${from}" from-mode="prompting">\n${safe}\n</cross-session-message>`;
}

/** Post a message to a live session's inbox, the way another Claude Code session would. */
export function postToInbox(session: LiveSession, body: string, timeoutMs = 5_000): Promise<void> {
  const inbox = session.inbox;
  if (!inbox) return Promise.reject(new Error("That Claude Code session can't receive messages."));
  return new Promise((resolve, reject) => {
    const socket = connect(inbox);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Claude Code's inbox did not answer."));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not reach that Claude Code window: ${error.message}`));
    });
    socket.once("connect", () => {
      const lines = session.token ? [JSON.stringify({ type: "auth", token: session.token })] : [];
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: envelope(body) } }));
      socket.end(`${lines.join("\n")}\n`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}
