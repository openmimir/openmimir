#!/usr/bin/env bun
/**
 * Checks how Mimir finds and runs coding agents on this machine. Runs in CI on
 * macOS and Windows, and on a fresh Windows install before a release.
 *
 *   bun scripts/platform-check.ts
 *
 * It installs nothing and calls no models. Exits non-zero when a check fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  commandOutput,
  discoverOpenCodeService,
  findClaude,
  killTree,
  openCodeVersionProblem,
  resolveCommand,
  spawnCommand,
} from "../packages/adapters/src/index.ts";
import { writeStdin } from "../packages/adapters/src/process.ts";
import { lines } from "../packages/adapters/src/util.ts";

const isWindows = process.platform === "win32";
let failures = 0;
const ok = (label: string, detail = "") => console.log(`ok    ${label}${detail ? `  ${detail}` : ""}`);
const fail = (label: string, detail = "") => {
  failures++;
  console.log(`FAIL  ${label}${detail ? `  ${detail}` : ""}`);
};
const info = (label: string, detail = "") => console.log(`info  ${label}${detail ? `  ${detail}` : ""}`);

console.log(`platform ${process.platform} ${process.arch}, bun ${Bun.version}\n`);

// 1. Which agents and tools are installed, and can Mimir run them?
for (const name of ["git", "node", "claude", "codex", "opencode"]) {
  const command = name === "claude" ? findClaude() : resolveCommand(name);
  if (!command) {
    info(name, "not installed");
    continue;
  }
  const version = await commandOutput(command, ["--version"]).catch((e) => `error: ${e}`);
  const runs = version && !version.startsWith("error");
  (runs ? ok : fail)(name, `${version.split("\n")[0]}  via ${command.argv.join(" ")}`);
}
for (const adapter of [new ClaudeCodeAdapter(), new CodexAdapter()]) {
  const health = await adapter.health();
  if (health.error?.includes("not installed")) continue;
  (health.ok ? ok : fail)(`${adapter.kind} adapter health`, health.ok ? `v${health.version}` : health.error);
}

// 2. A fake agent installed the way npm installs CLIs, run through the same code as real ones.
const node = resolveCommand("node");
if (!node) {
  info("fake agent", "skipped, needs node");
} else {
  const root = mkdtempSync(join(tmpdir(), "mimir-platform-"));
  const bin = join(root, "bin");
  const pkg = join(bin, "node_modules", "fake-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "cli.js"),
    `const { spawn } = require("node:child_process");
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
if (process.argv.includes("--hang")) {
  // Start a grandchild, like an agent running a shell command, then wait forever.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.argv[process.argv.length - 1], String(child.pid));
  console.log(JSON.stringify({ type: "started", args: process.argv.slice(2, -1) }));
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ type: "echo", args: process.argv.slice(2), prompt: input }));
  });
}
`,
  );
  if (isWindows) {
    // The shim npm writes today.
    writeFileSync(
      join(bin, "fake-agent.cmd"),
      `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-agent\\cli.js" %*\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, "fake-agent"),
      `#!/bin/sh\nexec node "$(dirname "$0")/node_modules/fake-agent/cli.js" "$@"\n`,
      {
        mode: 0o755,
      },
    );
  }
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` };
  const fake = resolveCommand("fake-agent", { env });
  if (!fake) fail("fake agent found on PATH");
  else {
    if (isWindows) {
      const direct = fake.argv.length === 2 && fake.argv[1]?.endsWith("cli.js") && !fake.batch;
      (direct ? ok : fail)("npm shim resolved to node + script", fake.argv.join(" "));
    }
    const version = await commandOutput(fake, ["--version"]);
    (version === "fake-agent 1.0.0" ? ok : fail)("fake agent --version", version);

    // Prompts with everything cmd.exe would mangle, and longer than Windows' command-line limit.
    const prompts = {
      tricky: `Fix the "login" test & check 100% of %PATH% | <dir> ^caret !bang\nsecond line\ttab, héllo 🚲 ทดสอบ`,
      long: "x".repeat(40_000),
    };
    for (const [name, prompt] of Object.entries(prompts)) {
      const proc = spawnCommand(
        fake,
        ["-p", "--disallowedTools", "Bash(git push *)", "PowerShell(Remove-Item *-r*)"],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      writeStdin(proc, prompt);
      let echoed: { prompt?: string; args?: string[] } = {};
      for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) echoed = JSON.parse(line);
      await proc.exited;
      const argsOk =
        echoed.args?.join("|") === "-p|--disallowedTools|Bash(git push *)|PowerShell(Remove-Item *-r*)";
      (echoed.prompt === prompt ? ok : fail)(
        `${name} prompt arrives intact on stdin`,
        `${prompt.length} chars`,
      );
      (argsOk ? ok : fail)(`${name} prompt: arguments intact`, echoed.args?.join(" ") ?? "");
    }

    // Stopping an agent stops what it started.
    const pidFile = join(root, "grandchild.pid");
    const proc = spawnCommand(fake, ["--hang", pidFile], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) {
      if (line.includes("started")) break;
    }
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    killTree(proc);
    await proc.exited;
    await Bun.sleep(1000);
    let alive = true;
    try {
      process.kill(grandchild, 0);
    } catch {
      alive = false;
    }
    (!alive ? ok : fail)("stopping an agent also stops its child processes", `grandchild ${grandchild}`);
    if (alive) process.kill(grandchild);
  }
  rmSync(root, { recursive: true, force: true });
}

// 3. OpenCode: version and background service.
const opencode = resolveCommand("opencode");
if (opencode) {
  const problem = await openCodeVersionProblem(opencode);
  if (problem) info("opencode version", problem);
  const service = await discoverOpenCodeService();
  info("opencode background service", service ? service.url : "not running (Mimir starts its own server)");
}

// 4. Where the agents keep their history.
for (const [label, dir] of [
  ["Claude Code history", join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")],
  ["Codex history", join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")],
] as const) {
  info(label, existsSync(dir) ? dir : `${dir} (none yet)`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
