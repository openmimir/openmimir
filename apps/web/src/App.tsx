import type { Snapshot } from "@openmimir/protocol";
import { Bike, Mic, MicOff, Monitor, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApprovalCard } from "./components/ApprovalCard";
import { Chat } from "./components/Chat";
import { Logo } from "./components/Logo";
import { Orb, type OrbMode } from "./components/Orb";
import { WorkerCard } from "./components/WorkerCard";
import { formatDuration } from "./lib/format";
import { useMimir } from "./lib/mimir";
import { useVoice } from "./lib/voice";

type Mode = "desk" | "trainer";

// Ctrl+Space switches keyboard input sources on macOS, and Cmd+Space is Spotlight.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const VOICE_SHORTCUT = IS_MAC ? "⌘⇧Space" : "Ctrl+Shift+Space";

function initialMode(): Mode {
  const param = new URLSearchParams(location.search).get("mode");
  if (param === "trainer" || param === "desk") return param;
  return localStorage.getItem("mimir.mode") === "trainer" ? "trainer" : "desk";
}

function orbMode(snapshot: Snapshot | null, local: ReturnType<typeof useVoice>["status"]): OrbMode {
  if (local === "connecting") return "connecting";
  if (local === "error") return "error";
  const voice = snapshot?.voice;
  if (voice?.status !== "live") return local === "live" ? "listening" : "off";
  if (voice.thinking && voice.speaking !== "mimir") return "thinking";
  if (voice.speaking === "mimir") return "speaking";
  if (voice.speaking === "user") return "user";
  return "listening";
}

const ORB_LABEL: Record<OrbMode, string> = {
  off: "Voice off",
  connecting: "Connecting…",
  listening: "Listening",
  user: "Hearing you",
  speaking: "Speaking",
  thinking: "Working on it",
  error: "Voice error",
};

export function App() {
  const mimir = useMimir();
  const voice = useVoice(mimir.api);
  const [mode, setModeState] = useState<Mode>(initialMode);
  const snapshot = mimir.snapshot;

  const setMode = (next: Mode) => {
    localStorage.setItem("mimir.mode", next);
    setModeState(next);
  };

  const voiceActive = voice.status === "live" || voice.status === "connecting";
  const toggleVoice = useCallback(() => {
    if (voice.status === "live" || voice.status === "connecting") void voice.stop();
    else void voice.start();
  }, [voice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((IS_MAC ? event.metaKey : event.ctrlKey) && event.shiftKey && event.code === "Space") {
        event.preventDefault();
        toggleVoice();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleVoice]);

  if (mimir.connection === "unpaired") {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <Orb mode="off" size={72} />
          <h1 className="mt-6 text-2xl font-semibold">This device is not paired</h1>
          <p className="mt-2 text-well-400">
            Run <code className="rounded bg-well-800 px-1.5 py-0.5 font-mono">mimir pair</code> on the Mac
            running Mimir and open the link here.
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="grid h-full place-items-center">
        <Orb mode="connecting" size={72} />
      </div>
    );
  }

  const orb = orbMode(snapshot, voice.status);
  const workersById = new Map(snapshot.workers.map((w) => [w.id, w]));
  const seconds = snapshot.voice.seconds ?? 0;

  const voiceButton = (
    <button
      type="button"
      onClick={toggleVoice}
      disabled={!snapshot.info.voiceConfigured || voice.status === "ending"}
      className={`grid size-10 place-items-center rounded-xl transition disabled:opacity-40 ${
        voiceActive ? "bg-accent/15 text-accent" : "text-well-400 hover:bg-well-800 hover:text-well-50"
      }`}
      title={snapshot.info.voiceConfigured ? `Voice (${VOICE_SHORTCUT})` : "Voice needs an OpenAI key"}
    >
      {voiceActive ? <PhoneOff size={18} /> : <Mic size={18} />}
    </button>
  );

  if (mode === "trainer") {
    return (
      <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
        <header className="flex items-center gap-4">
          <button type="button" onClick={toggleVoice} className="shrink-0" title="Toggle voice">
            <Orb mode={orb} levels={voice.levels} size={88} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-3xl font-bold tracking-tight">{ORB_LABEL[orb]}</div>
            <div className="text-lg text-well-400">
              {voiceActive ? formatDuration(seconds) : "Tap the well to talk"}
              {voice.muted && <span className="ml-3 text-needs">muted</span>}
            </div>
          </div>
          {voiceActive && (
            <button
              type="button"
              onClick={voice.toggleMute}
              className={`grid size-16 place-items-center rounded-2xl border ${voice.muted ? "border-needs text-needs" : "border-well-700 text-well-200"}`}
              title="Mute"
            >
              {voice.muted ? <MicOff size={28} /> : <Mic size={28} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("desk")}
            className="grid size-16 place-items-center rounded-2xl border border-well-700 text-well-400"
            title="Desk mode"
          >
            <Monitor size={26} />
          </button>
        </header>

        {voice.error && <div className="text-xl text-failed">{voice.error}</div>}

        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4">
            {snapshot.approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                big
                approval={approval}
                worker={workersById.get(approval.workerId)}
                onResolve={mimir.resolveApproval}
              />
            ))}
            {snapshot.workers.length === 0 ? (
              <div className="py-16 text-center text-2xl text-well-500">
                No workers yet. Ask Mimir to start one.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {snapshot.workers.slice(0, 6).map((worker) => (
                  <WorkerCard key={worker.id} worker={worker} big />
                ))}
              </div>
            )}
          </div>
        </main>

        <footer className="min-h-28 rounded-2xl border border-well-700 bg-well-900 p-5">
          {mimir.captions.user && (
            <div className={`text-xl ${mimir.captions.user.final ? "text-well-400" : "text-well-50"}`}>
              <span className="mr-2 font-semibold text-well-500">You</span>
              {mimir.captions.user.text}
            </div>
          )}
          {mimir.captions.mimir && (
            <div
              className={`mt-1 text-2xl font-medium ${mimir.captions.mimir.final ? "text-well-200" : "text-accent"}`}
            >
              <span className="mr-2 font-semibold text-accent-dim">Mimir</span>
              {mimir.captions.mimir.text}
            </div>
          )}
          {!mimir.captions.user && !mimir.captions.mimir && (
            <div className="text-xl text-well-500">Live captions appear here.</div>
          )}
        </footer>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[300px_1fr]">
      <aside className="scroll-thin hidden min-h-0 flex-col gap-4 overflow-y-auto border-r border-well-800 bg-well-900/60 p-4 md:flex">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Logo size={22} />
            <span className="text-lg font-semibold tracking-tight">Mimir</span>
          </div>
          <button
            type="button"
            onClick={() => setMode("trainer")}
            className="flex items-center gap-1.5 rounded-lg border border-well-700 px-2 py-1 text-xs text-well-400 transition hover:text-well-50"
            title="Trainer mode: big, glanceable screen"
          >
            <Bike size={14} /> Trainer
          </button>
        </div>

        <section className="flex items-center gap-3 rounded-xl border border-well-700 bg-well-900 p-3">
          <button
            type="button"
            onClick={toggleVoice}
            disabled={!snapshot.info.voiceConfigured}
            title={`Toggle voice (${VOICE_SHORTCUT})`}
          >
            <Orb mode={orb} levels={voice.levels} size={52} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{ORB_LABEL[orb]}</div>
            <div className="truncate text-xs text-well-400">
              {!snapshot.info.voiceConfigured
                ? "Add an OpenAI key to talk"
                : voiceActive
                  ? `${formatDuration(seconds)} · ${snapshot.info.voiceModel}`
                  : `${VOICE_SHORTCUT} to talk`}
            </div>
          </div>
          {voiceActive && (
            <button
              type="button"
              onClick={voice.toggleMute}
              className={`rounded-lg p-2 ${voice.muted ? "text-needs" : "text-well-400 hover:text-well-50"}`}
              title="Mute microphone"
            >
              {voice.muted ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
        </section>
        {voice.error && <div className="text-xs text-failed">{voice.error}</div>}

        {snapshot.approvals.length > 0 && (
          <section className="flex flex-col gap-2">
            {snapshot.approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                worker={workersById.get(approval.workerId)}
                onResolve={mimir.resolveApproval}
              />
            ))}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-well-500">
            Workers {snapshot.workers.length > 0 && `· ${snapshot.workers.length}`}
          </h2>
          {snapshot.workers.length === 0 && <p className="text-sm text-well-500">None yet.</p>}
          {snapshot.workers.map((worker) => (
            <WorkerCard key={worker.id} worker={worker} onStop={(id) => void mimir.stopWorker(id)} />
          ))}
        </section>

        <footer className="mt-auto flex flex-col gap-1 border-t border-well-800 pt-3 text-[11px] text-well-500">
          <StatusLine
            ok={mimir.connection === "open"}
            label={mimir.connection === "open" ? "Connected" : "Reconnecting…"}
          />
          <StatusLine
            ok={snapshot.info.opencode.connected}
            label={`OpenCode ${snapshot.info.opencode.connected ? `v${snapshot.info.opencode.version ?? ""}` : "offline"}`}
          />
          <StatusLine ok label={`Foreman ${snapshot.info.foremanModel}`} />
          <span className="mt-1">Mimir v{snapshot.info.version}</span>
        </footer>
      </aside>

      <main className="min-h-0">
        <Chat
          messages={snapshot.messages}
          activity={snapshot.activity}
          onSend={mimir.sendChat}
          voiceButton={voiceButton}
        />
      </main>
    </div>
  );
}

function StatusLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-1.5 rounded-full ${ok ? "bg-done" : "bg-failed"}`} />
      {label}
    </span>
  );
}
