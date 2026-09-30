import { AGENT_LABELS, type AgentSession } from "@openmimir/protocol";
import { Square } from "lucide-react";
import { projectName, STATUS, timeAgo } from "../lib/format";

/** A session as a card: compact in lists, large on the trainer screen. */
export function SessionCard({
  session,
  big = false,
  onStop,
}: {
  session: AgentSession;
  big?: boolean;
  onStop?: (id: string) => void;
}) {
  const status = STATUS[session.status];
  const Icon = status.icon;
  const detail = plain(session.error ?? session.lastText);
  return (
    <div
      className={`group relative shrink-0 overflow-hidden rounded-xl border bg-well-900 ${
        session.status === "needs_you" ? "border-needs/60" : "border-well-700"
      } ${big ? "p-5" : "p-3"}`}
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${status.bg}`} />
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="min-w-0">
          <div className={`truncate font-semibold text-well-50 ${big ? "text-2xl" : "text-sm"}`}>
            {session.title}
          </div>
          <div className={`truncate text-well-400 ${big ? "text-base" : "text-xs"}`}>
            {projectName(session.directory)} · {AGENT_LABELS[session.agent]} · {timeAgo(session.updatedAt)}
          </div>
        </div>
        {session.status === "working" && onStop && !big && (
          <button
            type="button"
            onClick={() => onStop(session.id)}
            className="rounded-md p-1 text-well-500 opacity-0 transition hover:bg-well-800 hover:text-well-50 group-hover:opacity-100"
            title="Stop"
          >
            <Square size={14} />
          </button>
        )}
      </div>
      <div
        className={`mt-2 flex items-center gap-1.5 pl-1 font-semibold uppercase tracking-wide ${status.color} ${big ? "text-lg" : "text-[11px]"}`}
      >
        <Icon
          size={big ? 20 : 13}
          className={session.status === "working" ? "animate-spin [animation-duration:2s]" : ""}
        />
        {status.label}
      </div>
      {detail && (
        <p
          className={`mt-1.5 pl-1 leading-relaxed ${big ? "line-clamp-3 text-lg text-well-200" : "line-clamp-2 text-xs text-well-400"}`}
        >
          {detail}
        </p>
      )}
    </div>
  );
}

/** One line in the conversation that tracks a session's live status. */
export function SessionLine({ session, text }: { session?: AgentSession; text: string }) {
  const status = session ? STATUS[session.status] : undefined;
  const Icon = status?.icon;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-well-800 bg-well-900/70 px-3 py-2 text-sm">
      {Icon && status ? (
        <Icon
          size={15}
          className={`mt-0.5 shrink-0 ${status.color} ${session?.status === "working" ? "animate-spin [animation-duration:2s]" : ""}`}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-well-200">{plain(text)}</div>
        {session && (
          <div className="mt-0.5 text-xs text-well-500">
            {projectName(session.directory)} · {AGENT_LABELS[session.agent]}
            {status && <span className={`ml-2 font-semibold ${status.color}`}>{status.label}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function plain(text: string | undefined): string {
  return (text ?? "").replace(/`+/g, "").replace(/\*\*/g, "");
}
