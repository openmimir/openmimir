import type { MessageSource, RiskTier } from "@openmimir/protocol";

/**
 * Anything that reaches the approval queue already needed a human according to
 * the agent itself, so the lowest tier here is `confirm`. Irreversible or
 * outward-facing actions are bumped to `screen`.
 */
const SCREEN_ONLY = [
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+branch\s+-D\b/,
  /\brm\s+-[a-z]*r[a-z]*f?\b/,
  /\brm\s+-[a-z]*f[a-z]*r\b/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bdeploy\b/,
  /\b(vercel|netlify|fly|wrangler|railway)\b/,
  /\bkubectl\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\bdocker\s+(push|rm|rmi|system\s+prune)\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bsudo\b/,
  /\bssh\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
];

export function classifyApproval(action: string, resources: string[]): RiskTier {
  const haystack = [action, ...resources].join("\n");
  if (SCREEN_ONLY.some((pattern) => pattern.test(haystack))) return "screen";
  if (action === "external_directory") return "screen";
  return "confirm";
}

/**
 * Shell command globs that always stop a worker for approval, even when the
 * user's own agent config allows everything. They mirror SCREEN_ONLY above.
 */
export const GUARDED_SHELL_COMMANDS = [
  "*git push*",
  "*git reset --hard*",
  "*git clean*",
  "*git branch -D*",
  "*rm -rf*",
  "*rm -fr*",
  "*npm publish*",
  "*pnpm publish*",
  "*yarn publish*",
  "*bun publish*",
  "*deploy*",
  "*vercel*",
  "*netlify*",
  "*wrangler*",
  "*railway*",
  "*kubectl*",
  "*terraform apply*",
  "*terraform destroy*",
  "*docker push*",
  "*docker rm*",
  "*docker system prune*",
  "*sudo *",
  "*ssh *",
  "*drop table*",
  "*drop database*",
  "*| sh*",
  "*| bash*",
];

export type ApprovalCheck = { allowed: true } | { allowed: false; reason: string };

/** Decide whether an approval may be granted from the given channel. */
export function canApprove(
  tier: RiskTier,
  source: MessageSource | "screen",
  userConfirmed: boolean,
): ApprovalCheck {
  if (source === "screen" || source === "text") return { allowed: true };
  if (tier === "screen") {
    return {
      allowed: false,
      reason: "This action can only be approved on a screen. It will wait until the user is back.",
    };
  }
  if (tier === "confirm" && !userConfirmed) {
    return {
      allowed: false,
      reason:
        "Read the action back to the user and ask them to say 'confirm'. Only call this again with user_confirmed=true after they do.",
    };
  }
  return { allowed: true };
}
