import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectRoots, expandHome } from "./config.ts";

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
