import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Approval, ChatMessage, Worker } from "@openmimir/protocol";

const SCHEMA_VERSION = 1;

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

  saveWorker(worker: Worker) {
    this.db
      .query("INSERT OR REPLACE INTO workers (id, external_id, updated_at, doc) VALUES (?, ?, ?, ?)")
      .run(worker.id, worker.externalId, worker.updatedAt, JSON.stringify(worker));
  }

  workers(limit = 50): Worker[] {
    const rows = this.db
      .query("SELECT doc FROM workers ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<{ doc: string }>;
    return rows.map((row) => JSON.parse(row.doc) as Worker);
  }

  workerByExternalId(externalId: string): Worker | undefined {
    const row = this.db.query("SELECT doc FROM workers WHERE external_id = ?").get(externalId) as {
      doc: string;
    } | null;
    return row ? (JSON.parse(row.doc) as Worker) : undefined;
  }

  worker(id: string): Worker | undefined {
    const row = this.db.query("SELECT doc FROM workers WHERE id = ?").get(id) as { doc: string } | null;
    return row ? (JSON.parse(row.doc) as Worker) : undefined;
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
