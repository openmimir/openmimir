import { join } from "node:path";
import { OpenCodeAdapter } from "@openmimir/adapters";
import {
  createForemanModel,
  EventBus,
  Foreman,
  type MimirConfig,
  mimirHome,
  ProjectIndex,
  Store,
  WorkerManager,
} from "@openmimir/core";
import type { ForemanActivity, ServerInfo, Snapshot, VoiceState } from "@openmimir/protocol";
import { type HistoryItem, LiveVoice } from "@openmimir/voice";

export type App = Awaited<ReturnType<typeof createApp>>;

export async function createApp(config: MimirConfig, version: string, log: (message: string) => void) {
  const bus = new EventBus();
  const store = new Store(process.env.MIMIR_DB ?? join(mimirHome(), "mimir.db"));
  const adapter = new OpenCodeAdapter({
    url: config.opencode.url,
    username: config.opencode.username,
    password: config.opencode.password,
    manage: config.opencode.manage,
    log,
  });
  const workers = new WorkerManager(adapter, store, bus);
  const projects = new ProjectIndex(config.projectRoots, config.projects);

  let foreman: Foreman | undefined;
  let foremanError: string | undefined;
  try {
    foreman = new Foreman({ model: createForemanModel(config), store, bus, workers, projects });
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
        onState: (state) => bus.publish({ type: "voice.state", voice: state }),
        onCaption: (caption) => {
          bus.publish({ type: "caption", caption });
          if (caption.final && caption.text)
            log(`[voice] ${caption.speaker === "user" ? "you" : "mimir"}: ${caption.text}`);
        },
        onDelegation: async (utterance, progress) => {
          if (!foreman) return `The foreman is not configured: ${foremanError}`;
          const reply = await foreman.handle({ text: utterance, source: "voice", onProgress: progress });
          return reply.text;
        },
      })
    : undefined;

  workers.onAnnouncement((announcement) => {
    foreman?.notice(announcement.text);
    voice?.announce(announcement.text);
  });

  let opencodeHealth = { ok: false, version: undefined as string | undefined };

  function info(): ServerInfo {
    return {
      version,
      foremanModel: config.foreman.model,
      voiceModel: config.voice.model,
      voiceConfigured: Boolean(voice),
      opencode: { url: adapter.url, connected: opencodeHealth.ok, version: opencodeHealth.version },
      projects: projects.list(),
    };
  }

  async function refreshHealth() {
    const health = await adapter.health();
    const changed = health.ok !== opencodeHealth.ok;
    opencodeHealth = { ok: health.ok, version: health.version };
    if (changed) bus.publish({ type: "info", info: info() });
  }

  function snapshot(): Snapshot {
    return {
      info: info(),
      messages: store.recentMessages(200),
      workers: workers.list(),
      approvals: workers.pendingApprovals(),
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

  let healthTimer: ReturnType<typeof setInterval> | undefined;

  return {
    config,
    bus,
    store,
    workers,
    voice,
    info,
    snapshot,
    voiceHistory,
    foreman: () => foreman,
    foremanError: () => foremanError,
    async start() {
      await adapter.start();
      await refreshHealth();
      healthTimer = setInterval(() => void refreshHealth(), 10_000);
    },
    async stop() {
      if (healthTimer) clearInterval(healthTimer);
      await voice?.close().catch(() => undefined);
      await adapter.stop();
      store.close();
    },
  };
}
