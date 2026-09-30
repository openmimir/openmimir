import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSession, Approval, ChatMessage } from "@openmimir/protocol";

const SCHEMA_VERSION = 3;

/**
 * Local persistence in a single SQLite file. Rows store JSON documents so the
 * protocol types can evolve without a migration for every new field.
 */
export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.db.query("SELECT value FROM meta WHERE key = 'schema'").get() as {
      value: string;
    } | null;
    const current = row ? Number(row.value) : 0;
    if (current > SCHEMA_VERSION) {
      throw new Error("The Mimir database was created by a newer version. Upgrade Mimir.");
    }
    if (current < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
        CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, external_id TEXT NOT NULL, updated_at INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS workers_external ON workers(external_id);
        CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
      `);
    }
    if (current < 2) this.migrateWorkersToTasks();
    if (current < 3) this.migrateTasksToSessions();
    this.db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)")
      .run(String(SCHEMA_VERSION));
  }

  saveMessage(message: ChatMessage) {
    this.db
      .query("INSERT OR REPLACE INTO messages (id, created_at, doc) VALUES (?, ?, ?)")
      .run(message.id, message.createdAt, JSON.stringify(message));
  }

  recentMessages(limit: number): ChatMessage[] {
    const rows = this.db
      .query("SELECT doc FROM messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ doc: string }>;
    return rows.map((row) => JSON.parse(row.doc) as ChatMessage).reverse();
  }

  /** v2: "workers" became "tasks", keyed by `${agent}:${externalId}`. */
  private migrateWorkersToTasks() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at);
    `);
    const workers = this.db.query("SELECT doc FROM workers").all() as Array<{ doc: string }>;
    const ids = new Map<string, string>();
    for (const row of workers) {
      const w = JSON.parse(row.doc) as Record<string, unknown>;
      const task: AgentSession = {
        id: `opencode:${w.externalId}`,
        agent: "opencode",
        title: String(w.title),
        directory: String(w.directory),
        status: w.status as AgentSession["status"],
        externalId: String(w.externalId),
        origin: "mimir",
        tracked: true,
        lastText: w.lastText as string | undefined,
        error: w.error as string | undefined,
        createdAt: Number(w.createdAt),
        updatedAt: Number(w.updatedAt),
      };
      ids.set(String(w.id), task.id);
      this.db
        .query("INSERT OR REPLACE INTO tasks (id, updated_at, doc) VALUES (?, ?, ?)")
        .run(task.id, task.updatedAt, JSON.stringify(task));
    }
    const approvals = this.db.query("SELECT id, doc FROM approvals").all() as Array<{
      id: string;
      doc: string;
    }>;
    for (const row of approvals) {
      const a = JSON.parse(row.doc) as Record<string, unknown>;
      const { workerId, ...rest } = a;
      const next = { ...rest, taskId: ids.get(String(workerId)) ?? String(workerId) };
      this.db.query("UPDATE approvals SET doc = ? WHERE id = ?").run(JSON.stringify(next), row.id);
    }
    this.db.exec("DROP TABLE IF EXISTS workers");
  }

  /** v3: "tasks" were renamed to "sessions", which is what every agent calls them. */
  private migrateTasksToSessions() {
    this.db.exec(`
      ALTER TABLE tasks RENAME TO sessions;
      DROP INDEX IF EXISTS tasks_updated;
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
    `);
    const approvals = this.db.query("SELECT id, doc FROM approvals").all() as Array<{
      id: string;
      doc: string;
    }>;
    for (const row of approvals) {
      const { taskId, ...rest } = JSON.parse(row.doc) as Record<string, unknown>;
      if (taskId === undefined) continue;
      this.db
        .query("UPDATE approvals SET doc = ? WHERE id = ?")
        .run(JSON.stringify({ ...rest, sessionId: taskId }), row.id);
    }
    const messages = this.db
      .query("SELECT id, doc FROM messages WHERE doc LIKE '%\"taskId\"%'")
      .all() as Array<{ id: string; doc: string }>;
    for (const row of messages) {
      const { taskId, ...rest } = JSON.parse(row.doc) as Record<string, unknown>;
      this.db
        .query("UPDATE messages SET doc = ? WHERE id = ?")
        .run(JSON.stringify({ ...rest, sessionId: taskId }), row.id);
    }
  }

  saveSession(session: AgentSession) {
    this.db
      .query("INSERT OR REPLACE INTO sessions (id, updated_at, doc) VALUES (?, ?, ?)")
      .run(session.id, session.updatedAt, JSON.stringify(session));
  }

  sessions(limit = 50): AgentSession[] {
    const rows = this.db
      .query("SELECT doc FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<{ doc: string }>;
    return rows.map((row) => JSON.parse(row.doc) as AgentSession);
  }

  session(id: string): AgentSession | undefined {
    const row = this.db.query("SELECT doc FROM sessions WHERE id = ?").get(id) as { doc: string } | null;
    return row ? (JSON.parse(row.doc) as AgentSession) : undefined;
  }

  saveApproval(approval: Approval) {
    this.db
      .query("INSERT OR REPLACE INTO approvals (id, status, created_at, doc) VALUES (?, ?, ?, ?)")
      .run(approval.id, approval.status, approval.createdAt, JSON.stringify(approval));
  }

  approval(id: string): Approval | undefined {
    const row = this.db.query("SELECT doc FROM approvals WHERE id = ?").get(id) as { doc: string } | null;
    return row ? (JSON.parse(row.doc) as Approval) : undefined;
  }

  pendingApprovals(): Approval[] {
    const rows = this.db
      .query("SELECT doc FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as Array<{ doc: string }>;
    return rows.map((row) => JSON.parse(row.doc) as Approval);
  }

  close() {
    this.db.close();
  }
}
