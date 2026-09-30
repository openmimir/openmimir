import type { MessageSource } from "@openmimir/protocol";

export interface DispatchInput {
  /** The user's own words that led to this, verbatim. Absent when Mimir acts on its own. */
  said?: string;
  source: Exclude<MessageSource, "system">;
  /** Mimir's instructions for the agent. */
  task: string;
  at?: Date;
}

/**
 * Every message Mimir sends into an agent session. It keeps the user's exact words
 * next to Mimir's reading of them, so a mishearing or misreading is visible in the
 * agent's own UI, and tells the agent its reply is relayed.
 */
export function formatDispatch({ said, source, task, at = new Date() }: DispatchInput): string {
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const lines = [`[Mimir · ${source === "voice" ? "voice" : "typed"} · ${time}]`];
  if (said?.trim()) lines.push(`The user said: "${said.trim()}"`);
  lines.push("", `Task: ${task.trim()}`, "");
  lines.push(
    "Reply: Mimir relays your reply to the user, who may be away from the screen. Lead with the answer or outcome, then anything the user must decide or do. Keep it short.",
  );
  return lines.join("\n");
}
