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
