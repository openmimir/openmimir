import { afterAll, expect, test } from "bun:test";
import { OpenCodeAdapter } from "./opencode.ts";
import type { AdapterEvent } from "./types.ts";

// Just enough of OpenCode 2's API: one session whose turn ended on a rejected
// permission, which leaves no "idle" entry in its history.
const now = Date.now();
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/info") return Response.json({ data: { version: "2.0.0" } });
    if (pathname === "/api/event") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (pathname === "/api/session/active") return Response.json({ data: {} });
    if (pathname === "/api/session") {
      return Response.json({
        data: [
          {
            id: "ses_1",
            title: "Delete build folder",
            location: { directory: "C:\\Users\\dev\\repos\\demo" },
            time: { created: now - 60_000, updated: now - 1_000 },
          },
        ],
      });
    }
    if (pathname === "/api/session/ses_1/message") return Response.json({ data: [{ type: "assistant" }] });
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

test("a turn that ended on a rejected permission does not look busy", async () => {
  const adapter = new OpenCodeAdapter({ url: `http://127.0.0.1:${server.port}`, manage: false });
  await adapter.start();
  // From the history alone (no idle entry, recently updated) it looks busy.
  expect((await adapter.listRecent(5))[0]?.running).toBe(true);

  const interrupted = new Promise<AdapterEvent>((resolve) =>
    adapter.onEvent((event) => {
      if (event.type === "interrupted") resolve(event);
    }),
  );
  while (!stream) await Bun.sleep(10);
  const event = { type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "rejected" } };
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  expect(await interrupted).toEqual({ type: "interrupted", externalId: "ses_1", reason: "rejected" });

  const [session] = await adapter.listRecent(5);
  expect(session?.directory).toBe("C:\\Users\\dev\\repos\\demo");
  expect(session?.running).toBe(false);
  await adapter.stop();
});
