import { describe, expect, test } from "bun:test";
import { toClaudeRules } from "./claude.ts";

describe("toClaudeRules", () => {
  test("each glob becomes a Bash rule and a PowerShell rule", () => {
    expect(toClaudeRules(["*git push*", "*rm -rf*"])).toEqual([
      "Bash(git push *)",
      "PowerShell(git push *)",
      "Bash(rm -rf *)",
      "PowerShell(rm -rf *)",
    ]);
  });

  test("globs with a wildcard inside keep it", () => {
    expect(toClaudeRules(["*Remove-Item*-Recurse*"])).toContain("PowerShell(Remove-Item*-Recurse*)");
    expect(toClaudeRules(["*Start-Process*-Verb RunAs*"])).toContain(
      "PowerShell(Start-Process*-Verb RunAs*)",
    );
  });

  test("patterns that cannot start a command are skipped", () => {
    expect(toClaudeRules(["*| sh*", "*| iex*", "*-Verb RunAs*", "**"])).toEqual([]);
  });

  test("duplicates collapse", () => {
    expect(toClaudeRules(["*sudo *", "*sudo*"])).toEqual(["Bash(sudo *)", "PowerShell(sudo *)"]);
  });
});
