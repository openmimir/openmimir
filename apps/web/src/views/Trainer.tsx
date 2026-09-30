import { Mic, MicOff, Monitor } from "lucide-react";
import { LiveCaptions } from "../components/LiveCaptions";
import { Orb } from "../components/Orb";
import { GlanceRow } from "../components/SessionCard";
import { TrainerFeed } from "../components/TrainerFeed";
import { formatDuration } from "../lib/format";
import { ORB_LABEL, orbMode } from "../lib/voiceUi";
import type { ViewProps } from "./types";

/**
 * Readable from a meter away, nothing to scroll. The conversation already shows every
 * session Mimir touches with live status; on top of it only what needs action.
 */
export function Trainer({
  snapshot,
  sessionsById,
  mimir,
  voice,
  voiceActive,
  toggleVoice,
  setMode,
  approvals,
}: ViewProps) {
  const orb = orbMode(snapshot, voice.status);
  const running = snapshot.sessions.filter((t) => t.status === "working").length;
  const waiting = snapshot.sessions.filter(
    (t) => t.status === "needs_you" && !snapshot.approvals.some((a) => a.sessionId === t.id),
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center gap-4">
        <button type="button" onClick={toggleVoice} className="shrink-0" title="Toggle voice">
          <Orb mode={orb} levels={voice.levels} size={88} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-3xl font-bold tracking-tight">{ORB_LABEL[orb]}</div>
          <div className="text-lg text-well-400">
            {voiceActive ? formatDuration(snapshot.voice.seconds ?? 0) : "Tap the well to talk"}
            {voice.muted && <span className="ml-3 text-needs">muted</span>}
            {running > 0 && (
              <span className="ml-3 font-semibold text-working">
                {running} session{running === 1 ? "" : "s"} running
              </span>
            )}
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
      {mimir.connection !== "open" && <div className="text-xl text-working">Reconnecting to Mimir…</div>}

      {(approvals.length > 0 || waiting.length > 0) && (
        <div className="flex flex-col gap-3">
          {approvals}
          {waiting.map((session) => (
            <GlanceRow key={session.id} session={session} />
          ))}
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        <TrainerFeed messages={snapshot.messages} sessions={sessionsById} />
      </main>

      <footer className="min-h-28 rounded-2xl border border-well-700 bg-well-900 p-5">
        {voiceActive ? (
          <LiveCaptions user={mimir.captions.user} mimir={mimir.captions.mimir} big />
        ) : (
          <div className="text-xl text-well-500">Live captions appear here while you talk.</div>
        )}
      </footer>
    </div>
  );
}
