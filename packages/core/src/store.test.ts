import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@openmimir/protocol";
import { Store } from "./store.ts";

describe("Store", () => {
  test("returns recent messages oldest first", () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 5; i++) {
      const message: ChatMessage = { id: `m${i}`, role: "user", source: "text", text: `${i}`, createdAt: i };
      store.saveMessage(message);
    }
    expect(store.recentMessages(3).map((m) => m.text)).toEqual(["2", "3", "4"]);
    store.close();
  });
});

describe("Store migrations", () => {
  test("v1 workers become v2 tasks and approvals follow", () => {
    const path = `${require("node:os").tmpdir()}/mimir-migrate-${Date.now()}.db`;
    const { Database } = require("bun:sqlite");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema', '1');
      CREATE TABLE messages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE workers (id TEXT PRIMARY KEY, external_id TEXT NOT NULL, updated_at INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
    `);
    const worker = {
      id: "wrk_1",
      externalId: "ses_1",
      title: "Fix",
      directory: "/r",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
    };
    db.query("INSERT INTO workers VALUES (?, ?, ?, ?)").run("wrk_1", "ses_1", 2, JSON.stringify(worker));
    const approval = { id: "apr_1", workerId: "wrk_1", status: "pending", createdAt: 3 };
    db.query("INSERT INTO approvals VALUES (?, ?, ?, ?)").run(
      "apr_1",
      "pending",
      3,
      JSON.stringify(approval),
    );
    db.close();

    const store = new Store(path);
    expect(store.task("opencode:ses_1")?.title).toBe("Fix");
    expect(store.pendingApprovals()[0]?.taskId).toBe("opencode:ses_1");
    store.close();
  });
});
