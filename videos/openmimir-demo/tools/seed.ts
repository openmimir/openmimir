// Seeds a throwaway Mimir home with the demo conversation, one stage at a time.
// Usage: MIMIR_HOME=<temp home> bun tools/seed.ts <stage 0-7>
// Never point this at your real ~/.openmimir.
import { Database } from "bun:sqlite";
import { join } from "node:path";

const home = process.env.MIMIR_HOME;
if (!home || home.endsWith(".openmimir")) throw new Error("Set MIMIR_HOME to a throwaway folder.");
const stage = Number(process.argv[2] ?? 7);
const db = new Database(join(home, "mimir.db"));
const repos = join(home, "repos");

const now = Date.now();
const min = 60_000;
const t0 = now - 6 * min;

type Status = "working" | "needs_you" | "failed" | "idle";
const session = (
  id: string,
  agent: "claude" | "codex" | "opencode",
  title: string,
  project: string,
  status: Status,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `${agent}:${id}`,
  agent,
  title,
  directory: join(repos, project),
  status,
  externalId: id,
  origin: "external",
  tracked: false,
  createdAt: updatedAt - 40 * min,
  updatedAt,
  ...extra,
});

const loginStatus: Status = stage >= 7 ? "idle" : "working";
const sessions = [
  session("bill1", "codex", "Billing refactor", "api", "working", now - 1 * min, {
    tracked: true,
    focusedAt: t0,
    lastText: "Migrating invoices table (3 of 4). Tests pass.",
  }),
  session("rate1", "claude", "Add rate limiting to public API", "api", "needs_you", now - 3 * min, {
    lastText: "Should limits be per API key or per IP?",
  }),
  session("docs1", "opencode", "Update install docs", "docs", "idle", now - 50 * min),
  session("auth1", "claude", "Review auth middleware", "web-app", "idle", now - 3 * 60 * min),
  session("ui1", "codex", "Dark mode for settings page", "web-app", "idle", now - 26 * 60 * min),
];
if (stage >= 6) {
  sessions.push(
    session("login1", "claude", "Fix flaky login test", "web-app", loginStatus, now - (stage >= 7 ? 0 : 1) * min, {
      origin: "mimir",
      tracked: true,
      focusedAt: now - 4 * min,
    }),
  );
}

let i = 0;
const msg = (role: string, source: string, text: string, extra: Record<string, unknown> = {}) => ({
  id: `demo_${++i}`,
  role,
  source,
  text,
  createdAt: t0 + i * 20_000,
  ...extra,
});

const all = [
  // stage 1: the question
  msg("user", "voice", "How's the billing refactor going?"),
  // stage 2: the answer
  msg("assistant", "voice", "Codex is on the last migration, 3 of 4. The tests are passing.", {
    steps: [{ id: "s1", label: "Checked", sessionId: "codex:bill1", state: "done" }],
  }),
  // stage 3: a new task
  msg("user", "voice", "Nice. Have Claude fix the flaky login test in web-app."),
  // stage 4: read-back
  msg("assistant", "voice", "I'll start Claude Code in web-app to fix the flaky login test. Go ahead?"),
  // stage 5: yes, started
  msg("user", "voice", "Yes."),
  msg("assistant", "voice", "On it. I'll tell you when it's done.", {
    steps: [
      {
        id: "s2",
        label: "Started a new Claude Code session in web-app",
        sessionId: "claude:login1",
        state: "done",
        message: "Fix the flaky login test in web-app. Find the cause, fix it, and run the test until it passes reliably.",
      },
    ],
  }),
  // stage 6: finished and reported
  msg("notice", "system", '"Fix flaky login test" finished.', { sessionId: "claude:login1", event: "finished" }),
  msg(
    "assistant",
    "voice",
    "Claude fixed it. The test was racing the session cookie; it now waits for it, and passed 50 runs in a row.",
  ),
];
// Stage n shows the first n messages; the last stage adds the finished notice and the report.
const visible = stage >= 7 ? all.length : stage;

db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM approvals;");
const putMessage = db.query("INSERT INTO messages (id, created_at, doc) VALUES (?, ?, ?)");
for (const m of all.slice(0, visible)) putMessage.run(m.id, m.createdAt, JSON.stringify(m));
const putSession = db.query("INSERT INTO sessions (id, updated_at, doc) VALUES (?, ?, ?)");
for (const s of sessions) putSession.run(s.id, s.updatedAt, JSON.stringify(s));
console.log(`stage ${stage}: ${visible} messages, ${sessions.length} sessions`);
