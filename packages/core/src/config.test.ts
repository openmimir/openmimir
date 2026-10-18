import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectRoots, expandHome, loadConfig } from "./config.ts";

const home = mkdtempSync(join(tmpdir(), "mimir-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("defaultProjectRoots", () => {
  test("falls back to ~/repos when nothing common exists", () => {
    expect(defaultProjectRoots(home, "darwin")).toEqual([join(home, "repos")]);
  });

  test("picks up the folders that exist, including Windows defaults", () => {
    mkdirSync(join(home, "code"));
    mkdirSync(join(home, "source", "repos"), { recursive: true });
    mkdirSync(join(home, "Documents", "GitHub"), { recursive: true });
    expect(defaultProjectRoots(home, "darwin")).toEqual([
      join(home, "code"),
      join(home, "source", "repos"),
      join(home, "Documents", "GitHub"),
    ]);
  });
});

describe("expandHome", () => {
  test("understands both ~/ and ~\\", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/repos")).toBe(join(homedir(), "repos"));
    expect(expandHome("~\\repos")).toBe(join(homedir(), "repos"));
  });
});

describe("loadConfig", () => {
  test("reads a config saved by Notepad with a byte order mark", () => {
    const dir = join(home, "mimir-home");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      `\uFEFF${JSON.stringify({ version: 2, server: { port: 4999 } })}\r\n`,
    );
    const before = process.env.MIMIR_HOME;
    process.env.MIMIR_HOME = dir;
    try {
      expect(loadConfig().server.port).toBe(4999);
    } finally {
      if (before === undefined) delete process.env.MIMIR_HOME;
      else process.env.MIMIR_HOME = before;
    }
  });
});
