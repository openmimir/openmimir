import { describe, expect, test } from "bun:test";
import { formatDispatch } from "./dispatch.ts";

describe("formatDispatch", () => {
  test("keeps the user's words next to the task", () => {
    const text = formatDispatch({
      said: "  are the migrations done? ",
      source: "voice",
      task: "Check whether the migrations finished. Read-only.",
      at: new Date(2026, 8, 30, 16, 12),
    });
    expect(text).toBe(
      [
        "[Mimir · voice · 16:12]",
        'The user said: "are the migrations done?"',
        "",
        "Task: Check whether the migrations finished. Read-only.",
        "",
        "Reply: Mimir relays your reply to the user, who may be away from the screen. Lead with the answer or outcome, then anything the user must decide or do. Keep it short.",
      ].join("\n"),
    );
  });

  test("leaves out the quote when Mimir acts on its own", () => {
    expect(formatDispatch({ source: "text", task: "Continue." })).not.toContain("The user said");
  });
});
