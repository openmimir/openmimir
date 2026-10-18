import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describeGrants, describeRequest, toClaudeRules } from "./claude.ts";

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

// Permission requests as Claude Code 2.1 sends them over --permission-prompt-tool stdio.
describe("describeRequest", () => {
  const project = "/work/app";

  test("an edit inside the project names the file relative to it", () => {
    const request = {
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      input: { file_path: "/work/app/src/hello.txt", content: "hi" },
      description: "hello.txt",
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    };
    expect(describeRequest(request, project)).toEqual({
      action: "edit",
      resources: [join("src", "hello.txt")],
    });
  });

  test("a command keeps Claude's description of it", () => {
    const request = {
      tool_name: "Bash",
      input: { command: "npm test", description: "Run the tests" },
      decision_reason: "This command requires approval",
      decision_reason_type: "other",
    };
    expect(describeRequest(request, project)).toEqual({
      action: "shell",
      resources: ["npm test"],
      message: "Run the tests",
    });
    expect(describeRequest({ ...request, tool_name: "PowerShell" }, project).action).toBe("shell");
  });

  test("anything outside the project is an outside-the-project request", () => {
    const request = {
      tool_name: "Write",
      input: { file_path: "/etc/hosts", content: "x" },
      decision_reason: "Path is outside allowed working directories",
      decision_reason_type: "workingDir",
    };
    expect(describeRequest(request, project)).toEqual({
      action: "external_directory",
      resources: ["/etc/hosts"],
      message: "Path is outside allowed working directories",
    });
  });

  test("other tools are named", () => {
    expect(describeRequest({ tool_name: "WebFetch", input: { url: "https://x.dev" } }, project)).toEqual({
      action: "webfetch",
      resources: ["https://x.dev"],
    });
    expect(
      describeRequest(
        { tool_name: "mcp__linear__create_issue", display_name: "Linear: create issue", input: {} },
        project,
      ),
    ).toEqual({ action: "tool", resources: ["Linear: create issue"] });
  });
});

describe("describeGrants", () => {
  test("Claude Code's own don't-ask-again options, in words", () => {
    expect(describeGrants([{ type: "setMode", mode: "acceptEdits", destination: "session" }])).toBe(
      "Allow all edits in this session",
    );
    expect(
      describeGrants([
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm test *" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ]),
    ).toBe('Always allow "npm test" commands in this project');
    expect(
      describeGrants([
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { type: "addDirectories", directories: ["/tmp/out"], destination: "session" },
      ]),
    ).toBe("Allow all edits in this session; allow access to /tmp/out in this session");
  });

  test("nothing to offer, no always option", () => {
    expect(describeGrants([])).toBeUndefined();
  });
});
