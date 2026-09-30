import { describe, expect, test } from "bun:test";
import { readSSE } from "./sse.ts";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readSSE", () => {
  test("yields data payloads across chunk boundaries and skips comments", async () => {
    const out: string[] = [];
    for await (const data of readSSE(stream(['data: {"a":1}\n\n: heartbeat\n\ndata: {"b"', ":2}\n\n"]))) {
      out.push(data);
    }
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});
