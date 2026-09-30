import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ApprovalDecision, ServerEvent } from "@openmimir/protocol";
import type { Server, ServerWebSocket } from "bun";
import type { App } from "./app.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const COOKIE = "mimir_pair";

interface SocketData {
  unsubscribe?: () => void;
}

export interface ServerOptions {
  app: App;
  port: number;
  host: string;
  allowedHosts: string[];
  secret: string;
  webDir: string;
  log: (message: string) => void;
}

function hostname(request: Request): string {
  const host = request.headers.get("host") ?? "";
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function startServer(options: ServerOptions): Server<SocketData> {
  const { app, secret, log } = options;
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...options.allowedHosts]);

  /**
   * Requests from this machine to a loopback hostname are trusted. Everything
   * else (other devices, tunnels such as Tailscale Serve) must have paired.
   * The Host check also blocks DNS-rebinding attacks from web pages.
   */
  function access(request: Request, server: Server<SocketData>): "trusted" | "paired" | "denied" {
    const host = hostname(request);
    if (!allowedHosts.has(host)) return "denied";
    const ip = server.requestIP(request)?.address ?? "";
    const loopbackIp = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (loopbackIp && LOOPBACK_HOSTS.has(host)) return "trusted";
    const cookie = readCookie(request, COOKIE);
    return cookie && safeEqual(cookie, secret) ? "paired" : "denied";
  }

  /** API calls must carry the token in a custom header, which also blocks CSRF. */
  function hasToken(request: Request): boolean {
    const token = request.headers.get("x-mimir-token");
    return Boolean(token && safeEqual(token, secret));
  }

  async function serveStatic(pathname: string): Promise<Response> {
    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = Bun.file(join(options.webDir, relative));
    if (relative === "/" || !(await file.exists())) {
      file = Bun.file(join(options.webDir, "index.html"));
      if (!(await file.exists())) {
        return new Response(
          "The web UI is not built yet. Run `bun run build` in the repo, or use `bun run dev:web`.",
          { status: 503 },
        );
      }
      return new Response(file, { headers: { "cache-control": "no-store" } });
    }
    const immutable = relative.startsWith("/assets/");
    return new Response(file, {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }

  async function api(request: Request, url: URL): Promise<Response> {
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/snapshot" && method === "GET") return json(app.snapshot());

    if (pathname === "/api/chat" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { text?: string };
      const text = body.text?.trim();
      if (!text) return json({ error: "text is required" }, 400);
      const foreman = app.foreman();
      if (!foreman) return json({ error: app.foremanError() }, 503);
      void foreman.handle({ text, source: "text" });
      return json({ ok: true }, 202);
    }

    const approval = pathname.match(/^\/api\/approvals\/([\w-]+)$/);
    if (approval && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { decision?: ApprovalDecision };
      if (!body.decision || !["approve", "approve_always", "reject"].includes(body.decision)) {
        return json({ error: "decision must be approve, approve_always or reject" }, 400);
      }
      // Approving from a screen is always allowed, whatever the tier.
      const result = await app.sessions.resolveApproval(approval[1] as string, body.decision);
      return json(result);
    }

    const latest = pathname.match(/^\/api\/sessions\/([^/]+)\/latest$/);
    if (latest && method === "GET") {
      const text = await app.sessions.latestText(decodeURIComponent(latest[1] as string));
      return json({ text: text ?? null });
    }

    const stop = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stop && method === "POST")
      return json(await app.sessions.stop(decodeURIComponent(stop[1] as string)));

    if (pathname === "/api/voice/session" && method === "POST") {
      if (!app.voice) return json({ error: "Voice needs an OpenAI API key. Run `mimir init`." }, 503);
      const body = (await request.json().catch(() => ({}))) as { sdp?: string };
      if (!body.sdp?.trim() || body.sdp.length > 65_536) return json({ error: "sdp is required" }, 400);
      const result = await app.voice.create({ sdp: body.sdp, history: app.voiceHistory() });
      return json(result, 201);
    }

    if (pathname === "/api/voice/close" && method === "POST") {
      await app.voice?.close();
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: options.host,
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url);
      const level = access(request, server);

      if (url.pathname === "/pair") {
        const code = url.searchParams.get("code") ?? "";
        if (!allowedHosts.has(hostname(request)) || !safeEqual(code, secret)) {
          return new Response("Pairing code is wrong or this host is not allowed.", { status: 403 });
        }
        const secure = url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": `${COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`,
          },
        });
      }

      if (level === "denied") {
        return new Response("Not paired. Run `mimir pair` on the Mac running Mimir.", { status: 401 });
      }

      if (url.pathname === "/api/bootstrap") {
        // No CORS headers, so other websites cannot read this token.
        return json({ token: secret });
      }

      if (url.pathname === "/api/ws") {
        if (!safeEqual(url.searchParams.get("token") ?? "", secret)) {
          return new Response("bad token", { status: 401 });
        }
        if (server.upgrade(request, { data: {} })) return undefined;
        return new Response("expected a websocket", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!hasToken(request)) return json({ error: "missing or wrong x-mimir-token" }, 401);
        try {
          return await api(request, url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`[api] ${request.method} ${url.pathname} failed: ${message}`);
          return json({ error: message }, 500);
        }
      }

      return serveStatic(url.pathname);
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const send = (event: ServerEvent) => ws.send(JSON.stringify(event));
        send({ type: "snapshot", snapshot: app.snapshot() });
        ws.data.unsubscribe = app.bus.subscribe(send);
      },
      message() {
        // Commands go over HTTP; the socket is server-to-client only.
      },
      close(ws: ServerWebSocket<SocketData>) {
        ws.data.unsubscribe?.();
      },
    },
  });

  if (!existsSync(join(options.webDir, "index.html"))) {
    log(`[server] web UI not found in ${options.webDir}`);
  }
  return server;
}
