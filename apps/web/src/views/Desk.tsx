import { AGENT_LABELS, type AgentSession } from "@openmimir/protocol";
import { Bike, ListTodo, Mic, MicOff, PhoneOff, X } from "lucide-react";
import { useState } from "react";
import { Chat } from "../components/Chat";
import { LiveCaptions } from "../components/LiveCaptions";
import { Logo } from "../components/Logo";
import { Orb } from "../components/Orb";
import { SessionCard } from "../components/SessionCard";
import { SessionDetail } from "../components/SessionDetail";
import { formatDuration } from "../lib/format";
import { ORB_LABEL, orbMode, VOICE_SHORTCUT } from "../lib/voiceUi";
import type { ViewProps } from "./types";

const isActive = (t: AgentSession) => t.status === "working" || t.status === "needs_you";
const FOCUS_MS = 30 * 60_000;
const inFocus = (t: AgentSession) => Boolean(t.focusedAt && Date.now() - t.focusedAt < FOCUS_MS);

/** Running first, then what Mimir is looking at, then what it drove, then everything else. */
function ordered(sessions: AgentSession[]): AgentSession[] {
  const rank = (t: AgentSession) => (isActive(t) ? 0 : inFocus(t) ? 1 : t.tracked ? 2 : 3);
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

export function Desk({
  snapshot,
  sessionsById,
  mimir,
  voice,
  voiceActive,
  toggleVoice,
  setMode,
  approvals,
}: ViewProps) {
  const [panel, setPanelState] = useState(() => localStorage.getItem("mimir.panel") === "open");
  const [selected, setSelected] = useState<string | null>(null);
  const setPanel = (open: boolean) => {
    localStorage.setItem("mimir.panel", open ? "open" : "closed");
    setPanelState(open);
  };
  const openSession = (id: string) => {
    setSelected(id);
    setPanel(true);
  };

  const orb = orbMode(snapshot, voice.status);
  const configured = snapshot.info.voiceConfigured;
  const sessions = ordered(snapshot.sessions);
  const activeCount = snapshot.sessions.filter(isActive).length;
  const selectedSession = selected ? sessionsById.get(selected) : undefined;

  const voiceButton = (
    <button
      type="button"
      onClick={toggleVoice}
      disabled={!configured || voice.status === "ending"}
      className={`grid size-10 place-items-center rounded-xl transition disabled:opacity-40 ${
        voiceActive ? "bg-accent/15 text-accent" : "text-well-400 hover:bg-well-800 hover:text-well-50"
      }`}
      title={configured ? `Voice (${VOICE_SHORTCUT})` : "Voice needs an OpenAI key"}
    >
      {voiceActive ? <PhoneOff size={18} /> : <Mic size={18} />}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-well-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Logo size={22} />
          <span className="text-lg font-semibold tracking-tight">Mimir</span>
        </div>

        <div className="mx-auto flex items-center gap-2 rounded-full border border-well-800 bg-well-900 py-1 pr-3 pl-1">
          <button
            type="button"
            onClick={toggleVoice}
            disabled={!configured}
            title={`Toggle voice (${VOICE_SHORTCUT})`}
          >
            <Orb mode={orb} levels={voice.levels} size={30} />
          </button>
          <span className="text-sm font-medium">{ORB_LABEL[orb]}</span>
          <span className="text-xs text-well-500">
            {!configured
              ? "add an OpenAI key"
              : voiceActive
                ? formatDuration(snapshot.voice.seconds ?? 0)
                : VOICE_SHORTCUT}
          </span>
          {voiceActive && (
            <button
              type="button"
              onClick={voice.toggleMute}
              className={`ml-1 rounded-full p-1 ${voice.muted ? "text-needs" : "text-well-400 hover:text-well-50"}`}
              title="Mute microphone"
            >
              {voice.muted ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setPanel(!panel)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition ${
            panel ? "border-accent-dim text-accent" : "border-well-700 text-well-400 hover:text-well-50"
          }`}
          title="Show sessions"
        >
          <ListTodo size={14} /> Sessions
          {activeCount > 0 && (
            <span className="rounded-full bg-working px-1.5 font-semibold text-well-950">{activeCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setMode("trainer")}
          className="flex items-center gap-1.5 rounded-lg border border-well-700 px-2.5 py-1 text-xs text-well-400 transition hover:text-well-50"
          title="Trainer mode: big, glanceable screen"
        >
          <Bike size={14} /> Trainer
        </button>
      </header>
      {mimir.connection !== "open" && (
        <div className="bg-working/10 px-4 py-1.5 text-center text-xs text-working">
          Reconnecting to Mimir…
        </div>
      )}
      {voice.error && (
        <div className="bg-failed/10 px-4 py-1.5 text-center text-xs text-failed">{voice.error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          <Chat
            messages={snapshot.messages}
            sessions={sessionsById}
            onOpenSession={openSession}
            onSend={mimir.sendChat}
            voiceButton={voiceButton}
            aboveComposer={
              <>
                {approvals.length > 0 && <div className="mb-3 flex flex-col gap-2">{approvals}</div>}
                {voiceActive && (
                  <div className="mb-3 rounded-xl border border-well-800 bg-well-900 px-4 py-3">
                    <LiveCaptions user={mimir.captions.user} mimir={mimir.captions.mimir} />
                  </div>
                )}
              </>
            }
          />
        </main>

        {panel && (
          <aside className="scroll-thin flex w-96 shrink-0 flex-col gap-2 overflow-y-auto border-l border-well-800 bg-well-900/60 p-4">
            {selectedSession && (
              <div className="mb-2 max-h-[55%] shrink-0 overflow-hidden">
                <SessionDetail
                  session={selectedSession}
                  onClose={() => setSelected(null)}
                  onStop={(id) => void mimir.stopSession(id)}
                  loadLatest={mimir.latestText}
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-well-500">
                Recent sessions, all agents
              </h2>
              <button
                type="button"
                onClick={() => setPanel(false)}
                className="text-well-500 hover:text-well-50"
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
            {sessions.length === 0 && <p className="text-sm text-well-500">Nothing yet.</p>}
            {sessions.slice(0, 20).map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                selected={session.id === selected}
                onOpen={openSession}
                onStop={(id) => void mimir.stopSession(id)}
              />
            ))}
            <footer className="mt-auto flex flex-col gap-1 border-t border-well-800 pt-3 text-[11px] text-well-500">
              {snapshot.info.agents.map((agent) => (
                <StatusLine
                  key={agent.kind}
                  ok={agent.available}
                  label={`${AGENT_LABELS[agent.kind]}${agent.detail ? ` ${agent.detail}` : ""}`}
                />
              ))}
              <StatusLine ok label={`Foreman ${snapshot.info.foremanModel}`} />
              <span className="mt-1">Mimir v{snapshot.info.version}</span>
            </footer>
          </aside>
        )}
      </div>
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
