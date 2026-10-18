import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { Subprocess } from "bun";
import { gitChanges } from "./git.ts";
import {
  type Command,
  commandOutput,
  endStdin,
  findAgentCommand,
  killTree,
  spawnCommand,
  writeLine,
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
  /** Where Mimir keeps the settings file it adds to every run. Defaults to a private temp folder. */
  settingsDir?: string;
  /** Extra environment for Claude Code, on top of Mimir's own. */
  env?: Record<string, string>;
  log?: (message: string) => void;
}

type Json = Record<string, unknown>;

/** A transcript that has not been written to for this long is not running, whatever it says. */
const STALE_MS = 10 * 60_000;
/** Search reads at most this many transcripts (newest first). */
const SEARCH_FILES = 400;
/**
 * Tools that only work with someone at Claude Code's own screen. Without them Claude
 * asks its questions in its reply, which Mimir passes on.
 */
const SCREEN_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

/** One headless turn. */
interface Run {
  proc: Subprocess;
  directory: string;
  sessionId?: string;
  /** The permission mode Claude Code started in (the user's own, unless Mimir set one). */
  mode?: string;
  /** Claude reported the turn's result; the process is on its way out. */
  finished: boolean;
  /** The user rejected a request, which ends the turn. */
  rejected: boolean;
}

/** What "always" allowed for the rest of a session. Claude Code itself forgets it when a run ends. */
interface Grants {
  /** "Allow all edits", given while the session ran in Claude Code's default mode. */
  acceptEdits: boolean;
  allow: Set<string>;
  dirs: Set<string>;
}

/** Finds the Claude Code CLI, also where its installer puts it when that isn't on PATH. */
export function findClaude(binary = "claude"): Command | undefined {
  return findAgentCommand(binary);
}

/**
 * Drives Claude Code through its headless mode (`claude -p`) and reads past
 * sessions from its transcripts in ~/.claude/projects. Whatever Claude Code would
 * ask permission for at the desk, it asks Mimir instead, over the channel its Agent
 * SDK uses (`--permission-prompt-tool stdio`).
 */
export class ClaudeCodeAdapter extends Emitter implements AgentAdapter {
  readonly kind = "claude";
  readonly supportsApprovals = true;
  readonly approvalsEndWithRun = true;
  private readonly binary: string;
  private readonly projectsDir: string;
  private settingsDir: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly running = new Map<string, Run>();
  /** Sessions the user asked to stop, so their exit reads as interrupted rather than failed. */
  private readonly interrupting = new Set<string>();
  /**
   * When each headless run Mimir started ended. A run that was stopped, or failed before
   * finishing its turn, leaves a history that looks mid-turn; this says otherwise.
   */
  private readonly exitedAt = new Map<string, number>();
  /** Permission requests waiting for the user, by Claude's request id. */
  private readonly pending = new Map<string, { run: Run; input: unknown; suggestions: Json[] }>();
  private readonly grants = new Map<string, Grants>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    super();
    this.binary = options.binary ?? "claude";
    this.projectsDir =
      options.projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    this.settingsDir = options.settingsDir;
    this.env = options.env;
  }

  async start() {}

  async stop() {
    for (const [id, run] of this.running) {
      this.interrupting.add(id);
      killTree(run.proc);
    }
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
          this.running.get(file.id)?.finished === false ||
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
    const current = this.running.get(session.externalId);
    if (current && !current.finished) {
      throw new Error(
        "Claude Code is still working on this session. Wait for it to finish or stop it first.",
      );
    }
    // The last turn is over; give its process a moment to exit before the next one starts.
    if (current) await Promise.race([current.proc.exited, Bun.sleep(5_000)]);
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
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // Messages in as JSON lines, so permission requests can be answered on the same pipe.
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--settings",
      this.settingsFile(guardedCommands),
      "--disallowedTools",
      ...SCREEN_TOOLS,
    ];
    if (resume) args.push("--resume", resume);
    const grants = resume ? this.grants.get(resume) : undefined;
    // At launch, so it applies before Claude's first tool call.
    if (grants?.acceptEdits) args.push("--permission-mode", "acceptEdits");
    if (grants?.allow.size) args.push("--allowedTools", ...grants.allow);
    if (grants?.dirs.size) args.push("--add-dir", ...grants.dirs);
    const proc = spawnCommand(this.command(), args, {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      ...(this.env ? { env: { ...process.env, ...this.env } } : {}),
    });
    const stderr = new Response(proc.stderr as ReadableStream).text().catch(() => "");
    const run: Run = { proc, directory, sessionId: resume, finished: false, rejected: false };
    // The prompt goes in on stdin: no quoting or length limits, on Windows included.
    writeLine(
      proc,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        session_id: "",
      }),
    );
    if (resume) {
      this.running.set(resume, run);
      this.emit({ type: "started", externalId: resume });
    }
    for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) {
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (event.type === "control_request") {
        this.onControlRequest(run, event);
        continue;
      }
      if (!run.sessionId && typeof event.session_id === "string") {
        run.sessionId = event.session_id;
        this.running.set(run.sessionId, run);
        onSessionId?.({ externalId: run.sessionId });
        this.emit({ type: "started", externalId: run.sessionId });
      }
      const sessionId = run.sessionId;
      if (!sessionId) continue;
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.permissionMode === "string") run.mode = event.permissionMode;
      } else if (event.type === "assistant") {
        const text = messageText(event);
        if (text) this.emit({ type: "text", externalId: sessionId, text });
      } else if (event.type === "result") {
        run.finished = true;
        // Claude Code waits for more messages until its input closes.
        endStdin(proc);
        if (!event.is_error) {
          this.emit({ type: "succeeded", externalId: sessionId });
        } else if (run.rejected) {
          this.emit({ type: "interrupted", externalId: sessionId, reason: "rejected" });
        } else {
          this.emit({
            type: "failed",
            externalId: sessionId,
            error: String(event.result ?? event.subtype ?? "failed"),
          });
        }
      }
    }
    await proc.exited;
    endStdin(proc);
    this.expire(run);
    const sessionId = run.sessionId;
    if (sessionId) {
      // A follow-up may already have started a new run of this session.
      if (this.running.get(sessionId) === run) this.running.delete(sessionId);
      this.exitedAt.set(sessionId, Date.now());
    }
    const interrupted = Boolean(sessionId && this.interrupting.delete(sessionId));
    if (!run.finished) {
      const output = (await stderr).trim();
      if (!sessionId) {
        throw new Error(
          `Claude Code exited before starting: ${output.slice(0, 300) || `code ${proc.exitCode}`}`,
        );
      }
      if (interrupted || proc.signalCode) {
        this.emit({ type: "interrupted", externalId: sessionId, reason: "user" });
      } else {
        this.emit({
          type: "failed",
          externalId: sessionId,
          error: output.slice(0, 300) || `exit code ${proc.exitCode}`,
        });
      }
    }
  }

  /** Claude Code asks before using a tool: turn that into an approval in Mimir. */
  private onControlRequest(run: Run, event: Json) {
    const requestId = String(event.request_id ?? "");
    const request = (event.request ?? {}) as Json;
    if (request.subtype !== "can_use_tool" || !run.sessionId) {
      // Mimir registers nothing else (hooks, in-process MCP servers), so don't leave Claude waiting.
      writeLine(
        run.proc,
        JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: requestId, error: "Not supported by OpenMimir." },
        }),
      );
      return;
    }
    const suggestions = Array.isArray(request.permission_suggestions)
      ? (request.permission_suggestions as Json[])
      : [];
    this.pending.set(requestId, { run, input: request.input, suggestions });
    this.emit({
      type: "permission.asked",
      externalId: run.sessionId,
      requestId,
      ...describeRequest(request, run.directory),
      always: describeGrants(suggestions),
    });
  }

  /** Requests of a run that ended can no longer be answered. */
  private expire(run: Run) {
    for (const [requestId, pending] of this.pending) {
      if (pending.run !== run) continue;
      this.pending.delete(requestId);
      if (run.sessionId) this.emit({ type: "permission.expired", externalId: run.sessionId, requestId });
    }
  }

  /**
   * Remember session-wide "always" grants, so later turns of the session have them too.
   * "Allow all edits" only carries over from Claude Code's default mode, so it never
   * replaces a mode the user chose (such as auto or plan).
   */
  private remember(externalId: string, suggestions: Json[], mode: string | undefined) {
    const grants = this.grants.get(externalId) ?? {
      acceptEdits: false,
      allow: new Set<string>(),
      dirs: new Set<string>(),
    };
    for (const suggestion of suggestions) {
      // Other destinations are settings files, which Claude Code updates itself.
      if (suggestion.destination !== "session") continue;
      if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits" && mode === "default") {
        grants.acceptEdits = true;
      }
      if (
        suggestion.type === "addRules" &&
        suggestion.behavior === "allow" &&
        Array.isArray(suggestion.rules)
      ) {
        for (const rule of suggestion.rules as Json[]) grants.allow.add(ruleText(rule));
      }
      if (suggestion.type === "addDirectories" && Array.isArray(suggestion.directories)) {
        for (const dir of suggestion.directories) grants.dirs.add(String(dir));
      }
    }
    this.grants.set(externalId, grants);
  }

  /**
   * Mimir's ask rules for risky commands, as a settings file Claude Code merges with
   * the user's own. Ask rules win over the user's allow rules and over bypass mode, and
   * anything that would ask is refused if Mimir can't be reached. The file is named
   * after its content and written in one step, so Claude never reads half of it.
   */
  private settingsFile(guardedCommands: string[]): string {
    const content = `${JSON.stringify({ permissions: { ask: toClaudeRules(guardedCommands) } }, null, 2)}\n`;
    this.settingsDir ??= mkdtempSync(join(tmpdir(), "openmimir-"));
    const file = join(this.settingsDir, `claude-settings-${Bun.hash(content).toString(16)}.json`);
    if (!existsSync(file)) {
      mkdirSync(this.settingsDir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, content);
      try {
        renameSync(temp, file);
      } catch {
        // Another run wrote the same file first.
        rmSync(temp, { force: true });
      }
    }
    return file;
  }

  async interrupt(externalId: string) {
    const run = this.running.get(externalId);
    if (!run) return;
    this.interrupting.add(externalId);
    killTree(run.proc);
  }

  async lastAssistantText(session: { externalId: string; directory: string }): Promise<string | undefined> {
    const file = this.files().find((f) => f.id === session.externalId);
    if (!file) return undefined;
    return (await this.summarize(file.path, file.id).catch(() => undefined))?.lastText;
  }

  async diff(session: { directory: string }): Promise<FileChange[]> {
    return gitChanges(session.directory);
  }

  async replyPermission(externalId: string, requestId: string, decision: PermissionDecision) {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.emit({ type: "permission.expired", externalId, requestId });
      throw new Error("Claude Code is no longer waiting for this: the run that asked has ended.");
    }
    this.pending.delete(requestId);
    let response: Json;
    if (decision === "reject") {
      pending.run.rejected = true;
      // Like pressing Esc in Claude Code: the turn stops and waits for the user.
      response = { behavior: "deny", message: "The user rejected this in OpenMimir.", interrupt: true };
    } else {
      response = { behavior: "allow", updatedInput: pending.input };
      if (decision === "always" && pending.suggestions.length > 0) {
        response.updatedPermissions = pending.suggestions;
        this.remember(externalId, pending.suggestions, pending.run.mode);
      }
    }
    writeLine(
      pending.run.proc,
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      }),
    );
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
 * Mimir's command globs as Claude Code permission rules, for its Bash tool and for
 * its PowerShell tool (the shell it uses on Windows): `*git push*` becomes
 * `Bash(git push *)` and `PowerShell(git push *)`. Claude Code matches PowerShell
 * aliases to their cmdlets, so `PowerShell(Remove-Item *-r*)` also covers `rm -r`.
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

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A Claude Code permission request in Mimir's terms (see describeAction and classifyApproval). */
export function describeRequest(
  request: Json,
  directory: string,
): { action: string; resources: string[]; message?: string } {
  const tool = String(request.tool_name ?? "");
  const input = (request.input ?? {}) as Json;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  let action = "tool";
  let resources = [text(request.display_name) ?? tool];
  if (tool === "Bash" || tool === "PowerShell") {
    action = "shell";
    resources = [text(input.command) ?? ""];
  } else if (EDIT_TOOLS.has(tool)) {
    action = "edit";
    resources = [path ? shortPath(path, directory) : ""];
  } else if (tool === "Read" || tool === "Glob" || tool === "Grep") {
    action = "read";
    resources = [path ? shortPath(path, directory) : (text(input.pattern) ?? "")];
  } else if (tool === "WebFetch") {
    action = "webfetch";
    resources = [text(input.url) ?? ""];
  } else if (tool === "WebSearch") {
    action = "websearch";
    resources = [text(input.query) ?? ""];
  }
  const outside = request.decision_reason_type === "workingDir";
  if (outside) action = "external_directory";
  return {
    action,
    resources: resources.filter(Boolean),
    message: text(input.description) ?? (outside ? text(request.decision_reason) : undefined),
  };
}

/** Paths inside the session's folder are shown relative to it. */
function shortPath(path: string, directory: string): string {
  const inside = relative(directory, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

function ruleText(rule: Json): string {
  return typeof rule.ruleContent === "string"
    ? `${rule.toolName}(${rule.ruleContent})`
    : String(rule.toolName);
}

/**
 * Claude Code's own "don't ask again" options, in words, e.g. "Allow all edits in this
 * session" or `Always allow "npm test" commands in this project`.
 */
export function describeGrants(suggestions: Json[]): string | undefined {
  const parts: string[] = [];
  for (const suggestion of suggestions) {
    const where =
      suggestion.destination === "session"
        ? "in this session"
        : suggestion.destination === "userSettings"
          ? "everywhere"
          : "in this project";
    if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits") {
      parts.push("allow all edits in this session");
    } else if (
      suggestion.type === "addRules" &&
      suggestion.behavior === "allow" &&
      Array.isArray(suggestion.rules)
    ) {
      const rules = (suggestion.rules as Json[]).map((rule) => {
        const shell = rule.toolName === "Bash" || rule.toolName === "PowerShell";
        const content = typeof rule.ruleContent === "string" ? rule.ruleContent : "";
        return shell && content ? `"${content.replace(/(:\*| \*)$/, "")}" commands` : ruleText(rule);
      });
      parts.push(`always allow ${rules.join(", ")} ${where}`);
    } else if (suggestion.type === "addDirectories" && Array.isArray(suggestion.directories)) {
      parts.push(`allow access to ${suggestion.directories.join(", ")} ${where}`);
    }
  }
  const text = parts.join("; ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : undefined;
}
