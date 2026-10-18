import { describe, expect, test } from "bun:test";
import { parseShim, quoteForCmd, resolveCommand } from "./process.ts";

// Real shims as npm, pnpm and older npm versions write them.
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

const OLD_NPM_SHIM = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\opencode-ai\\bin\\opencode" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\opencode-ai\\bin\\opencode" %*
)`;

const PNPM_SHIM = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
)`;

const EXE_SHIM = `@ECHO off
"%~dp0\\node_modules\\opencode-windows-x64\\bin\\opencode.exe" %*`;

function windows(files: Record<string, string>, env: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: "win32" as const,
    env,
    exists: (file: string) => lower.has(file.toLowerCase()),
    read: (file: string) => {
      const text = lower.get(file.toLowerCase());
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

const NPM = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const LOCAL_BIN = "C:\\Users\\dev\\.local\\bin";
const NODE = "C:\\Program Files\\nodejs";

describe("parseShim", () => {
  test("npm's current shim", () => {
    expect(parseShim(NPM_SHIM)).toEqual({
      target: "node_modules\\@openai\\codex\\bin\\codex.js",
      program: "node",
    });
  });

  test("older npm and pnpm shims", () => {
    expect(parseShim(OLD_NPM_SHIM)).toEqual({
      target: "node_modules\\opencode-ai\\bin\\opencode",
      program: "node",
    });
    expect(parseShim(PNPM_SHIM)?.target).toBe("global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseShim(PNPM_SHIM)?.program).toBe("node");
  });

  test("shims that launch an exe, and files that are not shims", () => {
    expect(parseShim(EXE_SHIM)?.target).toBe("node_modules\\opencode-windows-x64\\bin\\opencode.exe");
    expect(parseShim("@echo off\r\necho hello\r\n")).toBeUndefined();
  });
});

describe("resolveCommand on Windows", () => {
  test("a native exe wins in PATH order, like the shell", () => {
    const fs = windows(
      { [`${LOCAL_BIN}\\claude.exe`]: "", [`${NPM}\\claude.cmd`]: PNPM_SHIM },
      { Path: `${LOCAL_BIN};${NPM};${NODE}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    );
    expect(resolveCommand("claude", fs)).toEqual({
      argv: [`${LOCAL_BIN}\\claude.exe`],
      path: `${LOCAL_BIN}\\claude.exe`,
    });
  });

  test("an npm shim runs as node + script, without cmd.exe", () => {
    const fs = windows(
      { [`${NPM}\\codex.cmd`]: NPM_SHIM, [`${NODE}\\node.exe`]: "" },
      { PATH: `${NPM};${NODE}` },
    );
    expect(resolveCommand("codex", fs)).toEqual({
      argv: [`${NODE}\\node.exe`, `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`],
      path: `${NPM}\\codex.cmd`,
    });
  });

  test("a node.exe next to the shim is preferred", () => {
    const fs = windows(
      { [`${NPM}\\codex.cmd`]: NPM_SHIM, [`${NPM}\\node.exe`]: "", [`${NODE}\\node.exe`]: "" },
      { PATH: `${NPM};${NODE}` },
    );
    expect(resolveCommand("codex", fs)?.argv[0]).toBe(`${NPM}\\node.exe`);
  });

  test("a shim that points at an exe runs the exe", () => {
    const fs = windows({ [`${NPM}\\opencode.cmd`]: EXE_SHIM }, { PATH: NPM });
    expect(resolveCommand("opencode", fs)?.argv).toEqual([
      `${NPM}\\node_modules\\opencode-windows-x64\\bin\\opencode.exe`,
    ]);
  });

  test("unknown batch files are flagged, and missing commands are undefined", () => {
    const fs = windows(
      { "C:\\tools\\agent.bat": "@echo off\r\nC:\\tools\\real.exe %*" },
      { PATH: "C:\\tools" },
    );
    expect(resolveCommand("agent", fs)).toEqual({
      argv: ["C:\\tools\\agent.bat"],
      path: "C:\\tools\\agent.bat",
      batch: true,
    });
    expect(resolveCommand("nope", fs)).toBeUndefined();
  });

  test("callers can skip impostors, e.g. Claude Desktop's app alias", () => {
    const alias = "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps";
    const fs = windows(
      { [`${alias}\\claude.exe`]: "", [`${LOCAL_BIN}\\claude.exe`]: "" },
      { PATH: `${alias};${LOCAL_BIN}` },
    );
    const skip = (file: string) => file.toLowerCase().includes("\\windowsapps\\");
    expect(resolveCommand("claude", { ...fs, skip })?.path).toBe(`${LOCAL_BIN}\\claude.exe`);
  });

  test("explicit paths and quoted PATH entries", () => {
    const fs = windows({ "C:\\My Tools\\codex.exe": "" }, { PATH: '"C:\\My Tools"' });
    expect(resolveCommand("codex", fs)?.argv).toEqual(["C:\\My Tools\\codex.exe"]);
    expect(resolveCommand("C:\\My Tools\\codex.exe", fs)?.argv).toEqual(["C:\\My Tools\\codex.exe"]);
  });
});

describe("resolveCommand elsewhere", () => {
  test("walks PATH in order", () => {
    const files = new Set(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
    const found = resolveCommand("codex", {
      platform: "darwin",
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin" },
      exists: (f) => files.has(f),
    });
    expect(found?.argv).toEqual(["/opt/homebrew/bin/codex"]);
  });
});

describe("quoteForCmd", () => {
  test("quotes plain arguments, refuses ones cmd.exe would rewrite", () => {
    expect(quoteForCmd("Bash(git push *)")).toBe('"Bash(git push *)"');
    expect(() => quoteForCmd('say "hi"')).toThrow();
    expect(() => quoteForCmd("100%")).toThrow();
    expect(() => quoteForCmd("two\nlines")).toThrow();
  });
});
