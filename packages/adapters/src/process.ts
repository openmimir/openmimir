import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";

/**
 * Finding and running agent CLIs the same way on macOS, Linux and Windows.
 *
 * On Windows, `npm install -g` puts commands on PATH as `.cmd` batch shims. A batch
 * file can only run through cmd.exe, which cannot quote arbitrary arguments safely,
 * so shims are resolved to the program they launch (usually `node script.js`).
 * Prompts never travel as arguments anyway: adapters write them to stdin.
 */

export interface Command {
  /** Program plus any leading arguments, e.g. `[node.exe, ...\cli.js]`. */
  argv: string[];
  /** The file found on PATH, for messages. */
  path: string;
  /** An unrecognised batch file; only run through cmd.exe with simple arguments. */
  batch?: boolean;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
  /** Skip matches the caller knows are not the right program. */
  skip?: (file: string) => boolean;
  /**
   * Folders to try after PATH: where an agent's own installer puts it, in case that
   * folder isn't on PATH (Claude Code's Windows installer doesn't add it).
   */
  extraDirs?: string[];
}

/** Environment lookup that ignores case, as Windows does (`Path` vs `PATH`). */
function getEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

/** Find `name` on PATH and return how to run it, or undefined if it is not installed. */
export function resolveCommand(name: string, options: ResolveOptions = {}): Command | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    const pathVar = [getEnv(env, "PATH") ?? "", ...(options.extraDirs ?? [])].filter(Boolean).join(":");
    const found = options.exists
      ? findPosix(name, pathVar, options.exists, options.skip)
      : Bun.which(name, { PATH: pathVar });
    return found && !options.skip?.(found) ? { argv: [found], path: found } : undefined;
  }
  const exists = options.exists ?? existsSync;
  const read = options.read ?? ((file: string) => readFileSync(file, "utf8"));
  const win = path.win32;
  const extensions = (getEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => [".com", ".exe", ".bat", ".cmd"].includes(ext));
  const explicit = win.isAbsolute(name) || /[\\/]/.test(name);
  const dirs = explicit
    ? [""]
    : [...(getEnv(env, "PATH") ?? "").split(";"), ...(options.extraDirs ?? [])].filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? win.join(dir.replace(/^"|"$/g, ""), name) : name;
    const candidates = win.extname(name) ? [base] : extensions.map((ext) => base + ext);
    for (const file of candidates) {
      if (!exists(file) || options.skip?.(file)) continue;
      const command = fromWindowsFile(file, { env, exists, read, skip: options.skip });
      if (command) return command;
    }
  }
  return undefined;
}

function findPosix(
  name: string,
  pathVar: string,
  exists: (file: string) => boolean,
  skip?: (file: string) => boolean,
): string | undefined {
  if (name.includes("/")) return exists(name) ? name : undefined;
  for (const dir of pathVar.split(":").filter(Boolean)) {
    const file = path.posix.join(dir, name);
    if (exists(file) && !skip?.(file)) return file;
  }
  return undefined;
}

function fromWindowsFile(
  file: string,
  options: Required<Pick<ResolveOptions, "env" | "exists" | "read">> &
    Pick<ResolveOptions, "skip" | "extraDirs">,
): Command | undefined {
  const win = path.win32;
  const ext = win.extname(file).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { argv: [file], path: file };
  if (ext !== ".cmd" && ext !== ".bat") return undefined;
  let text = "";
  try {
    text = options.read(file);
  } catch {
    return { argv: [file], path: file, batch: true };
  }
  const shim = parseShim(text);
  if (!shim) return { argv: [file], path: file, batch: true };
  const dir = win.dirname(file);
  const target = win.resolve(dir, shim.target);
  if (/\.(exe|com)$/i.test(target)) return { argv: [target], path: file };
  // A script: run it with the interpreter the shim would use, preferring one next to the shim.
  const program = shim.program ?? "node";
  const local = win.join(dir, `${program}.exe`);
  const programFiles = getEnv(options.env, "ProgramFiles") ?? "C:\\Program Files";
  const interpreter = options.exists(local)
    ? local
    : resolveCommand(program, {
        ...options,
        platform: "win32",
        skip: undefined,
        extraDirs: program === "node" ? [win.join(programFiles, "nodejs")] : [],
      })?.argv[0];
  if (!interpreter) return undefined;
  return { argv: [interpreter, target], path: file };
}

/**
 * Read an npm/pnpm/yarn command shim. They all end with a line that runs
 * `"<interpreter>" "%~dp0\<relative target>" %*`; return that target and interpreter.
 */
export function parseShim(text: string): { target: string; program?: string } | undefined {
  const runs = [...text.matchAll(/"%~?dp0%?\\([^"]+)"\s*%\*/gi)];
  const last = runs.at(-1);
  if (!last?.[1]) return undefined;
  const target = last[1];
  // `SET "_prog=node"` (cmd-shim) or a bare `node  "%~dp0\..."` line (older shims).
  const prog =
    text.match(/SET\s+"_prog=([^"%\\]+)"/i)?.[1] ??
    text.match(/^\s*([\w.-]+)\s+"%~?dp0%?\\[^"]+"\s*%\*/im)?.[1];
  const program = prog?.replace(/\.exe$/i, "");
  return { target, program: program && program.toLowerCase() !== "%_prog%" ? program : undefined };
}

/**
 * Where agents' own installers and npm put their commands, for when those folders are
 * missing from PATH (a service, a fresh terminal, or an installer that never added them).
 */
export function agentDirs(env: Record<string, string | undefined> = process.env): string[] {
  const home = getEnv(env, "USERPROFILE") ?? getEnv(env, "HOME") ?? "";
  if (process.platform === "win32") {
    const appData = getEnv(env, "APPDATA") ?? path.win32.join(home, "AppData", "Roaming");
    return [
      path.win32.join(home, ".local", "bin"), // Claude Code's native installer
      path.win32.join(home, ".opencode", "bin"), // OpenCode's installer
      path.win32.join(appData, "npm"), // npm install -g
      path.win32.join(home, ".bun", "bin"), // bun install -g
    ];
  }
  return [
    path.posix.join(home, ".local", "bin"),
    path.posix.join(home, ".claude", "local"),
    path.posix.join(home, ".opencode", "bin"),
    path.posix.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * Find an agent (or git/node) the way Mimir always should: PATH first, then the folders
 * agents install into. Skips the Claude desktop app's Windows alias named claude.exe.
 */
export function findAgentCommand(name: string): Command | undefined {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const extra =
    name === "git" && process.platform === "win32"
      ? [path.win32.join(programFiles, "Git", "cmd")]
      : agentDirs();
  return resolveCommand(name, {
    extraDirs: extra,
    skip: name === "claude" ? (file) => /[\\/]WindowsApps[\\/]/i.test(file) : undefined,
  });
}

/** cmd.exe-quoted argument, for the rare batch file we could not resolve. */
export function quoteForCmd(arg: string): string {
  if (/["%!^\r\n]/.test(arg)) {
    throw new Error(`Cannot pass ${JSON.stringify(arg)} to a batch file safely.`);
  }
  return `"${arg}"`;
}

type SpawnOptions = Omit<NonNullable<Parameters<typeof Bun.spawn>[1]>, "cmd">;

/** Start a resolved command with extra arguments. */
export function spawnCommand(command: Command, args: string[], options: SpawnOptions = {}): Subprocess {
  if (command.batch) {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    const line = [command.argv[0] ?? "", ...args].map(quoteForCmd).join(" ");
    return Bun.spawn([comspec, "/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    } as SpawnOptions);
  }
  return Bun.spawn([...command.argv, ...args], options);
}

/** Write a prompt to a child's stdin and close it. Prompts never go on the command line. */
export function writeStdin(proc: Subprocess, text: string): void {
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") return;
  try {
    stdin.write(text);
    void Promise.resolve(stdin.end()).catch(() => undefined);
  } catch {
    // The process already exited; its exit code tells the rest.
  }
}

/**
 * Stop a process and everything it started (an agent's shell commands, dev servers).
 * Killing a process alone leaves its children running, on Windows and macOS alike.
 */
export function killTree(proc: Subprocess): void {
  if (proc.exitCode !== null || proc.signalCode) return;
  if (process.platform === "win32" && proc.pid) {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    try {
      Bun.spawnSync(
        [path.win32.join(root, "System32", "taskkill.exe"), "/pid", String(proc.pid), "/T", "/F"],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
    } catch {
      // Fall through to a plain kill.
    }
  } else if (proc.pid) {
    // Children first, so none of them get re-parented and missed.
    for (const pid of descendants(proc.pid).reverse()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  try {
    proc.kill();
  } catch {
    // Already gone.
  }
}

/** Every process below `pid`, parents before children (POSIX `ps`). */
function descendants(pid: number): number[] {
  let table = "";
  try {
    table = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="], {
      stdout: "pipe",
      stderr: "ignore",
    }).stdout.toString();
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() ?? 0) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** First line of a command's output, e.g. its version. */
export async function commandOutput(command: Command, args: string[]): Promise<string> {
  const proc = spawnCommand(command, args, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => killTree(proc), 15_000);
  try {
    const text = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}
