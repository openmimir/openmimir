import { join } from "node:path";
import { type AgentAdapter, ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter } from "@openmimir/adapters";
import {
  createForemanModel,
  EventBus,
  Foreman,
  type MimirConfig,
  mimirHome,
  ProjectIndex,
  SessionManager,
  Store,
} from "@openmimir/core";
import type { AgentKind, ForemanActivity, ServerInfo, Snapshot, VoiceState } from "@openmimir/protocol";
import { type HistoryItem, LiveVoice } from "@openmimir/voice";

export type App = Awaited<ReturnType<typeof createApp>>;

export async function createApp(config: MimirConfig, version: string, log: (message: string) => void) {
  const bus = new EventBus();
  const store = new Store(process.env.MIMIR_DB ?? join(mimirHome(), "mimir.db"));

  const opencode = new OpenCodeAdapter({
    url: config.opencode.url,
    username: config.opencode.username,
    password: config.opencode.password,
    manage: config.opencode.manage,
    log,
  });
  const adapters = new Map<AgentKind, AgentAdapter>([["opencode", opencode]]);
  if (config.agents.claude && Bun.which("claude")) adapters.set("claude", new ClaudeCodeAdapter({ log }));
  if (config.agents.codex && Bun.which("codex")) adapters.set("codex", new CodexAdapter({ log }));

  const sessions = new SessionManager(adapters, store, bus, log);
  const projects = new ProjectIndex(config.projectRoots, config.projects);
  const defaultAgent = adapters.has(config.agents.default) ? config.agents.default : "opencode";

  let foreman: Foreman | undefined;
  let foremanError: string | undefined;
  try {
    foreman = new Foreman({
      model: createForemanModel(config),
      store,
      bus,
      sessions,
      projects,
      defaultAgent,
    });
  } catch (error) {
    foremanError = error instanceof Error ? error.message : String(error);
    log(`[foreman] ${foremanError}`);
  }

  let activity: ForemanActivity = { busy: false };
  let voiceState: VoiceState = { status: "off" };
  bus.subscribe((event) => {
    if (event.type === "activity") activity = event.activity;
    if (event.type === "voice.state") voiceState = event.voice;
  });

  const voice = config.keys.openai
    ? new LiveVoice({
        apiKey: config.keys.openai,
        model: config.voice.model,
        voice: config.voice.voice,
        log,
        vocabulary: () => projects.list().map((p) => p.name),
        onState: (state) => bus.publish({ type: "voice.state", voice: state }),
        onCaption: (caption) => {
          bus.publish({ type: "caption", caption });
          if (caption.final && caption.text) {
            log(`[voice] ${caption.speaker === "user" ? "you" : "mimir"}: ${caption.text}`);
          }
        },
        onDelegation: async (utterance, progress) => {
          if (!foreman) return `The foreman is not configured: ${foremanError}`;
          const reply = await foreman.handle({ text: utterance, source: "voice", onProgress: progress });
          return reply.text;
        },
      })
    : undefined;

  sessions.onAnnouncement((announcement) => {
    if (announcement.kind === "finished" && foreman && announcement.result) {
      // Report back on the work instead of pasting the agent's reply.
      const session = sessions.get(announcement.sessionId);
      void foreman
        .followUp({
          sessionId: announcement.sessionId,
          title: session?.title ?? "A session",
          result: announcement.result,
          source: voice?.isLive ? "voice" : "text",
        })
        .then((reply) => voice?.announce(reply.text))
        .catch((error) =>
          log(`[foreman] follow-up failed: ${error instanceof Error ? error.message : error}`),
        );
      return;
    }
    // A start already shows as a step in the reply that caused it.
    if (announcement.kind === "started") return;
    foreman?.notice(announcement.text, announcement.sessionId);
    voice?.announce(announcement.text);
  });

  const health = new Map<AgentKind, { ok: boolean; detail?: string }>();

  function info(): ServerInfo {
    return {
      version,
      foremanModel: config.foreman.model,
      voiceModel: config.voice.model,
      voiceConfigured: Boolean(voice),
      agents: [...adapters.keys()].map((kind) => ({
        kind,
        available: health.get(kind)?.ok ?? false,
        detail: health.get(kind)?.detail,
      })),
      projects: projects.list(),
    };
  }

  async function refreshHealth() {
    let changed = false;
    for (const [kind, adapter] of adapters) {
      const result = await adapter.health();
      const detail = result.ok ? (result.version ? `v${result.version}` : undefined) : result.error;
      const previous = health.get(kind);
      if (previous?.ok !== result.ok) changed = true;
      health.set(kind, { ok: result.ok, detail });
    }
    if (changed) bus.publish({ type: "info", info: info() });
  }

  function snapshot(): Snapshot {
    return {
      info: info(),
      messages: store.recentMessages(200),
      sessions: sessions.list(),
      approvals: sessions.pendingApprovals(),
      voice: voiceState,
      activity,
    };
  }

  function voiceHistory(): HistoryItem[] {
    return store
      .recentMessages(30)
      .filter((m) => m.role !== "notice" && !m.pending)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
  }

  const timers: Array<ReturnType<typeof setInterval>> = [];

  return {
    config,
    bus,
    store,
    sessions,
    voice,
    opencode,
    info,
    snapshot,
    voiceHistory,
    foreman: () => foreman,
    foremanError: () => foremanError,
    async start() {
      await Promise.all([...adapters.values()].map((adapter) => adapter.start()));
      await refreshHealth();
      await sessions.refresh(true).catch(() => undefined);
      timers.push(setInterval(() => void refreshHealth(), 10_000));
      timers.push(setInterval(() => void sessions.refresh().catch(() => undefined), 5_000));
    },
    async stop() {
      for (const timer of timers) clearInterval(timer);
      await voice?.close().catch(() => undefined);
      await Promise.all([...adapters.values()].map((adapter) => adapter.stop()));
      store.close();
    },
  };
}
