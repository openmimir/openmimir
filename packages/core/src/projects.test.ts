import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectIndex } from "./projects.ts";

const root = mkdtempSync(join(tmpdir(), "mimir-projects-"));
for (const name of ["openmimir", "web-app", "notes"]) {
  mkdirSync(join(root, name, name === "notes" ? "" : ".git"), { recursive: true });
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ProjectIndex", () => {
  const index = new ProjectIndex([root], []);

  test("finds git repositories one level deep", () => {
    expect(index.list().map((p) => p.name)).toEqual(["openmimir", "web-app"]);
  });

  test("matches spoken names loosely", () => {
    expect(index.resolve("open mimir")?.name).toBe("openmimir");
    expect(index.resolve("Web App")?.name).toBe("web-app");
    expect(index.resolve("mimir")?.name).toBe("openmimir");
    expect(index.resolve("nothing like it")).toBeUndefined();
  });
});
