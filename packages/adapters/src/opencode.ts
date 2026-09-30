import type { Subprocess } from "bun";
import { readSSE } from "./sse.ts";
import type { AdapterEvent, AdapterHealth, AgentAdapter, FileChange, PermissionDecision } from "./types.ts";

export interface OpenCodeAdapterOptions {
  /** Base URL of an OpenCode v2 server, e.g. http://127.0.0.1:4096 */
  url: string;
  username?: string;
  password?: string;
  /**
   * When true and nothing answers at `url`, Mimir starts `opencode serve`
   * itself with the given password and stops it again on shutdown.
   */
  manage?: boolean;
  binary?: string;
  log?: (message: string) => void;
}

/** Talks to OpenCode v2 over its HTTP API (`/api/...`) and event stream. */
export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode";
  readonly url: string;
  private readonly options: OpenCodeAdapterOptions;
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private child: Subprocess | undefined;
  private streamAbort: AbortController | undefined;
  private stopped = false;

  constructor(options: OpenCodeAdapterOptions) {
    this.options = options;
    this.url = options.url.replace(/\/$/, "");
  }

  private log(message: string) {
    this.options.log?.(`[opencode] ${message}`);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.options.password) {
      const user = this.options.username ?? "opencode";
      headers.authorization = `Basic ${btoa(`${user}:${this.options.password}`)}`;
    }
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenCode ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    if (response.status === 204) return undefined as T;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) {
      throw new Error(
        `OpenCode ${method} ${path} returned ${type || "no content type"}, expected JSON. Is this an OpenCode v2 server?`,
      );
    }
    return (await response.json()) as T;
  }

  async health(): Promise<AdapterHealth> {
    try {
      const info = await this.request<{ data?: { version?: string } } & { version?: string }>(
        "GET",
        "/api/info",
      );
      return { ok: true, version: info.data?.version ?? info.version };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    let health = await this.health();
    if (!health.ok && this.options.manage) {
      await this.spawn();
      health = await this.waitForHealth(15_000);
    }
    if (!health.ok) {
      this.log(`not reachable at ${this.url}: ${health.error}`);
    } else {
      this.log(`connected to ${this.url}${health.version ? ` (v${health.version})` : ""}`);
    }
    void this.streamEvents();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.streamAbort?.abort();
    if (this.child) {
      this.child.kill();
      await this.child.exited.catch(() => undefined);
      this.child = undefined;
    }
  }

  private async spawn() {
    const port = new URL(this.url).port || "4096";
    const hostname = new URL(this.url).hostname;
    const binary = this.options.binary ?? "opencode";
    this.log(`starting \`${binary} serve --port ${port}\``);
    try {
      this.child = Bun.spawn([binary, "serve", "--port", port, "--hostname", hostname], {
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: this.options.password ?? "",
          OPENCODE_SERVER_USERNAME: this.options.username ?? "opencode",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      this.log(`could not start OpenCode: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<AdapterHealth> {
    const deadline = Date.now() + timeoutMs;
    let health: AdapterHealth = { ok: false, error: "timed out" };
    while (Date.now() < deadline) {
      health = await this.health();
      if (health.ok) return health;
      await Bun.sleep(300);
    }
    return health;
  }

  onEvent(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AdapterEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(`listener error: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async streamEvents() {
    let delay = 500;
    while (!this.stopped) {
      this.streamAbort = new AbortController();
      try {
        const response = await fetch(`${this.url}/api/event`, {
          headers: this.headers({ accept: "text/event-stream" }),
          signal: this.streamAbort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`event stream ${response.status}`);
        delay = 500;
        for await (const data of readSSE(response.body)) {
          this.handleRaw(data);
        }
      } catch (error) {
        if (this.stopped) return;
        this.log(`event stream dropped (${error instanceof Error ? error.message : error}), retrying`);
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private handleRaw(data: string) {
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const d = event.data ?? {};
    const externalId = typeof d.sessionID === "string" ? d.sessionID : undefined;
    if (!externalId) return;
    switch (event.type) {
      case "session.execution.started":
        this.emit({ type: "started", externalId });
        break;
      case "session.text.ended":
        if (typeof d.text === "string" && d.text.trim()) {
          this.emit({ type: "text", externalId, text: d.text });
        }
        break;
      case "session.execution.succeeded":
        this.emit({ type: "succeeded", externalId });
        break;
      case "session.execution.failed":
        this.emit({ type: "failed", externalId, error: describeError(d.error) });
        break;
      case "session.execution.interrupted":
        this.emit({ type: "interrupted", externalId, reason: String(d.reason ?? "unknown") });
        break;
      case "permission.asked":
        this.emit({
          type: "permission.asked",
          externalId,
          requestId: String(d.id),
          action: String(d.action ?? "unknown"),
          resources: Array.isArray(d.resources) ? d.resources.map(String) : [],
          message: typeof d.message === "string" ? d.message : undefined,
        });
        break;
      case "permission.replied":
        this.emit({
          type: "permission.replied",
          externalId,
          requestId: String(d.requestID),
          decision: d.reply === "always" ? "always" : d.reply === "reject" ? "reject" : "once",
        });
        break;
    }
  }

  async createSession(input: { directory: string; title: string; guardedCommands?: string[] }) {
    const result = await this.request<{ data: { id: string } }>("POST", "/api/session", {
      title: input.title,
      location: { directory: input.directory },
      metadata: { createdBy: "openmimir" },
      // Session rules take precedence over the user's global OpenCode config.
      permissions: (input.guardedCommands ?? []).map((resource) => ({
        action: "shell",
        resource,
        effect: "ask",
      })),
    });
    return { externalId: result.data.id };
  }

  async prompt(externalId: string, text: string) {
    await this.request("POST", `/api/session/${externalId}/prompt`, { text });
  }

  async interrupt(externalId: string) {
    await this.request("POST", `/api/session/${externalId}/interrupt`);
  }

  async lastAssistantText(externalId: string): Promise<string | undefined> {
    const result = await this.request<{
      data: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    }>("GET", `/api/session/${externalId}/message?limit=20&order=desc`);
    for (const message of result.data) {
      if (message.type !== "assistant" || !message.content) continue;
      const text = message.content
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return undefined;
  }

  async diff(externalId: string): Promise<FileChange[]> {
    const result = await this.request<{ data: FileChange[] }>(
      "GET",
      `/api/session/${externalId}/diff?context=3`,
    );
    return result.data;
  }

  async replyPermission(externalId: string, requestId: string, decision: PermissionDecision) {
    await this.request("POST", `/api/session/${externalId}/permission/${requestId}/reply`, {
      decision,
    });
  }
}

function describeError(error: unknown): string {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (
      typeof e.data === "object" &&
      e.data &&
      typeof (e.data as { message?: unknown }).message === "string"
    ) {
      return (e.data as { message: string }).message;
    }
    return JSON.stringify(error).slice(0, 300);
  }
  return String(error);
}
