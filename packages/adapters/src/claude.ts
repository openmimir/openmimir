import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { gitChanges } from "./git.ts";
import {
  type Command,
  commandOutput,
  findAgentCommand,
  killTree,
  spawnCommand,
  writeStdin,
} from "./process.ts";
import type { AdapterHealth, AgentAdapter, FileChange, PermissionDecision, SessionSummary } from "./types.ts";
import {
  Emitter,
  headAndTail,
  lines,
  matchesProject,
  oneLine,
  parseJsonLines,
  type SessionQuery,
  scoreText,
} from "./util.ts";

export interface ClaudeCodeAdapterOptions {
  binary?: string;
  /** Defaults to ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects. */
  projectsDir?: string;
  log?: (message: string) => void;
}

type Json = Record<string, unknown>;

/** A transcript that has not been written to for this long is not running, whatever it says. */
const STALE_MS = 10 * 60_000;
/** Search reads at most this many transcripts (newest first). */
const SEARCH_FILES = 400;

/** Finds the Claude Code CLI, also where its installer puts it when that isn't on PATH. */
export function findClaude(binary = "claude"): Command | undefined {
  return findAgentCommand(binary);
}

/**
 * Drives Claude Code through its headless mode (`claude -p`) and reads past
 * sessions from its transcripts in ~/.claude/projects.
 */
export class ClaudeCodeAdapter extends Emitter implements AgentAdapter {
  readonly kind = "claude";
  readonly supportsApprovals = false;
  private readonly binary: string;
  private readonly projectsDir: string;
  private readonly running = new Map<string, Subprocess>();
  /** Sessions the user asked to stop, so their exit reads as interrupted rather than failed. */
  private readonly interrupting = new Set<string>();
  /**
   * When each headless run Mimir started ended. A run that was stopped, or failed before
   * finishing its turn, leaves a history that looks mid-turn; this says otherwise.
   */
  private readonly exitedAt = new Map<string, number>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    super();
    this.binary = options.binary ?? "claude";
    this.projectsDir =
      options.projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  }

  async start() {}

  async stop() {
    for (const proc of this.running.values()) killTree(proc);
    this.running.clear();
  }

  private command(): Command {
    const command = findClaude(this.binary);
    if (!command) throw new Error("Claude Code is not installed (no `claude` on PATH).");
    return command;
  }

  async health(): Promise<AdapterHealth> {
    const command = findClaude(this.binary);
    if (!command) return { ok: false, error: "claude is not installed" };
    const version = (await commandOutput(command, ["--version"]).catch(() => "")).split(" ")[0];
    if (!version) return { ok: false, error: `could not run ${command.path}` };
    return { ok: true, version };
  }

  /** Every transcript on disk, newest first, with the project folder it lives in. */
  private files(): Array<{ path: string; id: string; folder: string; mtime: number; ctime: number }> {
    const files: Array<{ path: string; id: string; folder: string; mtime: number; ctime: number }> = [];
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.projectsDir);
    } catch {
      return [];
    }
    for (const dir of dirs) {
      const full = join(this.projectsDir, dir);
      let entries: string[] = [];
      try {
        entries = readdirSync(full);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const path = join(full, entry);
        const stat = statSync(path);
        files.push({
          path,
          id: entry.slice(0, -6),
          folder: dir,
          mtime: stat.mtimeMs,
          ctime: stat.birthtimeMs,
        });
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  /** True if a run Mimir started for this session ended after the transcript was last written. */
  private endedAfter(file: { id: string; mtime: number }): boolean {
    const exited = this.exitedAt.get(file.id);
    return exited !== undefined && file.mtime <= exited + 2_000;
  }

  private async toSummaries(
    files: Array<{ path: string; id: string; mtime: number; ctime: number }>,
    bytes = 256 * 1024,
  ): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const summary = await this.summarize(file.path, file.id, bytes).catch(() => undefined);
      if (!summary) continue;
      const { midTurn, ...rest } = summary;
      summaries.push({
        ...rest,
        externalId: file.id,
        updatedAt: file.mtime,
        createdAt: file.ctime,
        // Headless runs Mimir started are known; for the user's own terminals, infer from the transcript.
        running:
          this.running.has(file.id) ||
          (midTurn && Date.now() - file.mtime < STALE_MS && !this.endedAfter(file)),
      });
    }
    return summaries;
  }

  async listRecent(limit: number): Promise<SessionSummary[]> {
    return this.toSummaries(this.files().slice(0, limit));
  }

  async search(query: SessionQuery): Promise<SessionSummary[]> {
    // Project folders are named after the working directory, so filter before reading anything.
    const candidates = this.files()
      .filter((f) => !query.project || matchesProject(f.folder.replaceAll("-", "/"), query.project))
      .slice(0, SEARCH_FILES);
    const summaries = await this.toSummaries(candidates, 64 * 1024);
    return summaries
      .map((s) => ({ s, score: scoreText(query.text, { title: s.title, body: s.lastText }) }))
      .filter((m) => m.score > 0 && matchesProject(m.s.directory, query.project))
      .sort((a, b) => b.score - a.score || b.s.updatedAt - a.s.updatedAt)
      .slice(0, query.limit)
      .map((m) => m.s);
  }

  private async summarize(path: string, id: string, bytes = 256 * 1024) {
    const { head, tail } = await headAndTail(path, bytes);
    const first = parseJsonLines(head);
    const last = parseJsonLines(tail);
    let directory = "";
    let firstPrompt = "";
    for (const entry of first) {
      if (!directory && typeof entry.cwd === "string") directory = entry.cwd;
      if (!firstPrompt && entry.type === "user" && !entry.isMeta) {
        const text = messageText(entry);
        // Skip slash-command wrappers and other injected context.
        if (text && !text.startsWith("<") && !text.startsWith("Caveat:")) firstPrompt = text;
      }
      if (directory && firstPrompt) break;
    }
    let title = "";
    let lastText: string | undefined;
    // A turn is over once the last message is an assistant reply that ended the turn.
    let midTurn = false;
    for (const entry of last) {
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") title = entry.customTitle;
      if (!title && entry.type === "ai-title" && typeof entry.aiTitle === "string") title = entry.aiTitle;
      if (entry.type === "assistant") {
        lastText = messageText(entry) || lastText;
        const stop = (entry.message as { stop_reason?: string | null } | undefined)?.stop_reason;
        // The turn goes on while Claude calls tools or is still streaming; any other stop
        // (end_turn, stop_sequence, max_tokens, refusal, an API error such as "Not logged in") ends it.
        midTurn = !entry.isApiErrorMessage && (stop === "tool_use" || stop === "pause_turn" || stop == null);
      } else if (entry.type === "user" && !entry.isMeta) {
        midTurn = true;
      }
    }
    if (!directory) return undefined;
    return {
      title: title || oneLine(firstPrompt) || `Claude session ${id.slice(0, 8)}`,
      directory,
      lastText,
      midTurn,
    };
  }

  async createSession(input: {
    directory: string;
    title: string;
    prompt: string;
    guardedCommands: string[];
  }) {
    return new Promise<{ externalId: string }>((resolve, reject) => {
      void this.run(input.directory, input.prompt, input.guardedCommands, undefined, resolve).catch(reject);
    });
  }

  async prompt(session: { externalId: string; directory: string }, text: string, guardedCommands: string[]) {
    if (this.running.has(session.externalId)) {
      throw new Error(
        "Claude Code is still working on this session. Wait for it to finish or stop it first.",
      );
    }
    void this.run(session.directory, text, guardedCommands, session.externalId);
  }

  /** Run one headless turn. Resolves `onSessionId` as soon as Claude reports the session id. */
  private async run(
    directory: string,
    prompt: string,
    guardedCommands: string[],
    resume: string | undefined,
    onSessionId?: (value: { externalId: string }) => void,
  ) {
    // The prompt goes in on stdin: no quoting or length limits, on Windows included.
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resume) args.push("--resume", resume);
    const disallowed = toClaudeRules(guardedCommands);
    if (disallowed.length > 0) args.push("--disallowedTools", ...disallowed);
    const proc = spawnCommand(this.command(), args, {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    writeStdin(proc, prompt);
    let sessionId = resume;
    let finished = false;
    if (sessionId) {
      this.running.set(sessionId, proc);
      this.emit({ type: "started", externalId: sessionId });
    }
    for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) {
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (!sessionId && typeof event.session_id === "string") {
        sessionId = event.session_id;
        this.running.set(sessionId, proc);
        onSessionId?.({ externalId: sessionId });
        this.emit({ type: "started", externalId: sessionId });
      }
      if (!sessionId) continue;
      if (event.type === "assistant") {
        const text = messageText(event);
        if (text) this.emit({ type: "text", externalId: sessionId, text });
      } else if (event.type === "result") {
        finished = true;
        if (event.is_error) {
          this.emit({
            type: "failed",
            externalId: sessionId,
            error: String(event.result ?? event.subtype ?? "failed"),
          });
        } else {
          this.emit({ type: "succeeded", externalId: sessionId });
        }
      }
    }
    await proc.exited;
    if (sessionId) {
      this.running.delete(sessionId);
      this.exitedAt.set(sessionId, Date.now());
    }
    const interrupted = Boolean(sessionId && this.interrupting.delete(sessionId));
    if (!finished) {
      const stderr = (await new Response(proc.stderr as ReadableStream).text()).trim();
      if (!sessionId) {
        throw new Error(
          `Claude Code exited before starting: ${stderr.slice(0, 300) || `code ${proc.exitCode}`}`,
        );
      }
      if (interrupted || proc.signalCode) {
        this.emit({ type: "interrupted", externalId: sessionId, reason: "user" });
      } else {
        this.emit({
          type: "failed",
          externalId: sessionId,
          error: stderr.slice(0, 300) || `exit code ${proc.exitCode}`,
        });
      }
    }
  }

  async interrupt(externalId: string) {
    const proc = this.running.get(externalId);
    if (!proc) return;
    this.interrupting.add(externalId);
    killTree(proc);
  }

  async lastAssistantText(session: { externalId: string; directory: string }): Promise<string | undefined> {
    const file = this.files().find((f) => f.id === session.externalId);
    if (!file) return undefined;
    return (await this.summarize(file.path, file.id).catch(() => undefined))?.lastText;
  }

  async diff(session: { directory: string }): Promise<FileChange[]> {
    return gitChanges(session.directory);
  }

  async replyPermission(_externalId: string, _requestId: string, _decision: PermissionDecision) {
    throw new Error("Claude Code approvals are handled in Claude Code itself.");
  }
}

function messageText(entry: Json): string {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Mimir's command globs as Claude Code deny rules, for its Bash tool and for its
 * PowerShell tool (the shell it uses on Windows): `*git push*` becomes
 * `Bash(git push *)` and `PowerShell(git push *)`. Claude Code matches PowerShell
 * aliases to their cmdlets, so `PowerShell(Remove-Item *-r*)` also stops `rm -r`.
 */
export function toClaudeRules(globs: string[]): string[] {
  const rules = new Set<string>();
  for (const glob of globs) {
    const core = glob.replace(/^\*+|\*+$/g, "").trim();
    // Rules match from the start of a command; pipes and flags are not command starts.
    if (!core || core.startsWith("|") || core.startsWith("-")) continue;
    const pattern = core.includes("*") ? `${core}*` : `${core} *`;
    rules.add(`Bash(${pattern})`);
    rules.add(`PowerShell(${pattern})`);
  }
  return [...rules];
}
