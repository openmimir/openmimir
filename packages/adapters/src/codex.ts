import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { gitChanges } from "./git.ts";
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

export interface CodexAdapterOptions {
  binary?: string;
  /** Defaults to ~/.codex/sessions. */
  sessionsDir?: string;
  log?: (message: string) => void;
}

type Json = Record<string, unknown>;

/** A rollout that has not been written to for this long is not running, whatever it says. */
const STALE_MS = 10 * 60_000;
/** Search reads at most this many rollouts (newest first). */
const SEARCH_FILES = 400;

/**
 * Drives Codex through `codex exec --json` and reads past sessions from its
 * rollout files in ~/.codex/sessions/YYYY/MM/DD.
 */
export class CodexAdapter extends Emitter implements AgentAdapter {
  readonly kind = "codex";
  readonly supportsApprovals = false;
  private readonly binary: string;
  private readonly sessionsDir: string;
  private readonly running = new Map<string, Subprocess>();

  constructor(options: CodexAdapterOptions = {}) {
    super();
    this.binary = options.binary ?? "codex";
    this.sessionsDir = options.sessionsDir ?? join(homedir(), ".codex", "sessions");
  }

  async start() {}

  async stop() {
    for (const proc of this.running.values()) proc.kill();
    this.running.clear();
  }

  async health(): Promise<AdapterHealth> {
    const path = Bun.which(this.binary);
    if (!path) return { ok: false, error: "codex is not installed" };
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
    const version = (await new Response(proc.stdout).text()).trim().split(" ").pop();
    return { ok: true, version };
  }

  /** Rollout files, newest day first; stops once enough files are found. */
  private recentFiles(limit: number): Array<{ path: string; mtime: number; ctime: number }> {
    const found: Array<{ path: string; mtime: number; ctime: number }> = [];
    const sortedDirs = (dir: string) => {
      try {
        return readdirSync(dir)
          .filter((d) => /^\d+$/.test(d))
          .sort()
          .reverse();
      } catch {
        return [];
      }
    };
    for (const year of sortedDirs(this.sessionsDir)) {
      for (const month of sortedDirs(join(this.sessionsDir, year))) {
        for (const day of sortedDirs(join(this.sessionsDir, year, month))) {
          const dir = join(this.sessionsDir, year, month, day);
          for (const entry of readdirSync(dir)) {
            if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
            const path = join(dir, entry);
            const stat = statSync(path);
            found.push({ path, mtime: stat.mtimeMs, ctime: stat.birthtimeMs });
          }
          if (found.length >= limit * 2) {
            return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
          }
        }
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  private async toSummaries(
    files: Array<{ path: string; mtime: number; ctime: number }>,
    bytes = 256 * 1024,
  ): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const summary = await this.summarize(file.path, bytes).catch(() => undefined);
      if (!summary) continue;
      const { midTurn, ...rest } = summary;
      summaries.push({
        ...rest,
        updatedAt: file.mtime,
        createdAt: file.ctime,
        running: this.running.has(summary.externalId) || (midTurn && Date.now() - file.mtime < STALE_MS),
      });
    }
    return summaries;
  }

  async listRecent(limit: number): Promise<SessionSummary[]> {
    return this.toSummaries(this.recentFiles(limit));
  }

  async search(query: SessionQuery): Promise<SessionSummary[]> {
    const summaries = await this.toSummaries(this.recentFiles(SEARCH_FILES), 96 * 1024);
    return summaries
      .map((s) => ({ s, score: scoreText(query.text, { title: s.title, body: s.lastText }) }))
      .filter((m) => m.score > 0 && matchesProject(m.s.directory, query.project))
      .sort((a, b) => b.score - a.score || b.s.updatedAt - a.s.updatedAt)
      .slice(0, query.limit)
      .map((m) => m.s);
  }

  private async summarize(path: string, bytes = 256 * 1024) {
    const { head, tail } = await headAndTail(path, bytes);
    let externalId = "";
    let directory = "";
    let firstPrompt = "";
    for (const entry of parseJsonLines(head)) {
      const payload = (entry.payload ?? {}) as Json;
      if (entry.type === "session_meta") {
        externalId = String(payload.id ?? payload.session_id ?? "");
        directory = String(payload.cwd ?? "");
      }
      const item = payload.item as Json | undefined;
      if (!firstPrompt && item?.type === "UserMessage") firstPrompt = itemText(item);
      if (externalId && firstPrompt) break;
    }
    let lastText: string | undefined;
    // Every turn logs task_started and, when it ends, task_complete.
    let midTurn = false;
    for (const entry of parseJsonLines(tail)) {
      const payload = entry.payload as Json | undefined;
      if (payload?.type === "task_started") midTurn = true;
      if (payload?.type === "task_complete" || payload?.type === "turn_aborted") midTurn = false;
      const item = payload?.item as Json | undefined;
      if (item?.type === "AgentMessage") lastText = itemText(item) || lastText;
    }
    if (!externalId || !directory) return undefined;
    return {
      externalId,
      directory,
      title: oneLine(stripTags(firstPrompt)) || `Codex session ${externalId.slice(0, 8)}`,
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
      void this.run(input.directory, input.prompt, undefined, resolve).catch(reject);
    });
  }

  async prompt(session: { externalId: string; directory: string }, text: string) {
    if (this.running.has(session.externalId)) {
      throw new Error("Codex is still working on this session. Wait for it to finish or stop it first.");
    }
    void this.run(session.directory, text, session.externalId);
  }

  private async run(
    directory: string,
    prompt: string,
    resume: string | undefined,
    onSessionId?: (value: { externalId: string }) => void,
  ) {
    const args = resume
      ? [this.binary, "exec", "resume", resume, "--json", "--skip-git-repo-check", prompt]
      : [this.binary, "exec", "--json", "--skip-git-repo-check", "-C", directory, prompt];
    const proc = Bun.spawn(args, { cwd: directory, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let threadId = resume;
    let finished = false;
    if (threadId) {
      this.running.set(threadId, proc);
      this.emit({ type: "started", externalId: threadId });
    }
    for await (const line of lines(proc.stdout)) {
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string" && !threadId) {
        threadId = event.thread_id;
        this.running.set(threadId, proc);
        onSessionId?.({ externalId: threadId });
        this.emit({ type: "started", externalId: threadId });
      }
      if (!threadId) continue;
      const item = event.item as Json | undefined;
      if (
        event.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        this.emit({ type: "text", externalId: threadId, text: item.text });
      } else if (event.type === "turn.completed") {
        finished = true;
        this.emit({ type: "succeeded", externalId: threadId });
      } else if (event.type === "turn.failed" || event.type === "error") {
        finished = true;
        const error =
          (event.error as { message?: string } | undefined)?.message ?? String(event.message ?? "failed");
        this.emit({ type: "failed", externalId: threadId, error });
      }
    }
    await proc.exited;
    if (threadId) this.running.delete(threadId);
    if (!finished) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      if (!threadId)
        throw new Error(`Codex exited before starting: ${stderr.slice(0, 300) || `code ${proc.exitCode}`}`);
      if (proc.signalCode) this.emit({ type: "interrupted", externalId: threadId, reason: "user" });
      else
        this.emit({
          type: "failed",
          externalId: threadId,
          error: stderr.slice(-300) || `exit code ${proc.exitCode}`,
        });
    }
  }

  async interrupt(externalId: string) {
    this.running.get(externalId)?.kill();
  }

  async lastAssistantText(session: { externalId: string }): Promise<string | undefined> {
    const recent = await this.listRecent(40);
    return recent.find((s) => s.externalId === session.externalId)?.lastText;
  }

  async diff(session: { directory: string }): Promise<FileChange[]> {
    return gitChanges(session.directory);
  }

  async replyPermission(_externalId: string, _requestId: string, _decision: PermissionDecision) {
    throw new Error("Codex approvals are handled by its own sandbox settings.");
  }
}

function itemText(item: Json): string {
  const content = item.content;
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}
