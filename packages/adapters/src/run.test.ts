import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "./claude.ts";
import type { AdapterEvent } from "./types.ts";

// A fake `claude` installed the way npm installs CLIs (a .cmd shim on Windows), so this
// runs the real launch path: finding the command, the prompt on stdin, stream-json out.
const root = mkdtempSync(join(tmpdir(), "mimir run test "));
const bin = join(root, "bin");
const projects = join(root, "projects");
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(bin, "node_modules", "fake-claude"), { recursive: true });
writeFileSync(
  join(bin, "node_modules", "fake-claude", "cli.js"),
  `const fs = require("node:fs");
const path = require("node:path");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  // Like a run that fails before answering (e.g. not logged in): the transcript ends on the prompt.
  const projects = path.join(__dirname, "..", "..", "..", "projects");
  const dir = path.join(projects, "repo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fake-session.jsonl"), JSON.stringify({ type: "user", cwd: process.cwd(), message: { role: "user", content: prompt } }) + "\\n");
  fs.writeFileSync(path.join(projects, "args.json"), JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }));
  process.exit(1);
});
`,
);
if (process.platform === "win32") {
  writeFileSync(
    join(bin, "fake-claude.cmd"),
    `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0\\node_modules\\fake-claude\\cli.js" %*\r\n`,
  );
} else {
  writeFileSync(
    join(bin, "fake-claude"),
    `#!/bin/sh\nexec node "$(dirname "$0")/node_modules/fake-claude/cli.js" "$@"\n`,
    {
      mode: 0o755,
    },
  );
}

describe("Claude Code headless runs", () => {
  test("the prompt goes in on stdin, and a run that ended is not shown as running", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: join(bin, "fake-claude"), projectsDir: projects });
    const events: AdapterEvent[] = [];
    const failed = new Promise<void>((resolve) =>
      adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "failed") resolve();
      }),
    );
    const prompt = 'Fix the "login" test & check 100% of %PATH%\nsecond line, héllo 🚲';
    const { externalId } = await adapter.createSession({
      directory: root,
      title: "test",
      prompt,
      guardedCommands: ["*git push*", "*Remove-Item*-Recurse*"],
    });
    expect(externalId).toBe("fake-session");
    await failed;

    const args = JSON.parse(readFileSync(join(projects, "args.json"), "utf8")) as string[];
    expect(args).toContain("PowerShell(git push *)");
    expect(args).toContain("PowerShell(Remove-Item*-Recurse*)");
    expect(args).not.toContain(prompt);

    const [summary] = await adapter.listRecent(5);
    expect(summary?.externalId).toBe("fake-session");
    expect(summary?.title).toContain('Fix the "login" test');
    // The transcript ends on the prompt (it looks mid-turn), but Mimir saw the run end.
    expect(summary?.running).toBe(false);
  });
});
