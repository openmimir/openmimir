import { AGENT_LABELS, type AgentSession } from "@openmimir/protocol";
import { Square } from "lucide-react";
import { projectName, STATUS, timeAgo } from "../lib/format";

/** A session in the desk side panel. */
export function SessionCard({
  session,
  onStop,
  onOpen,
  selected = false,
}: {
  session: AgentSession;
  onStop?: (id: string) => void;
  onOpen?: (id: string) => void;
  selected?: boolean;
}) {
  const status = STATUS[session.status];
  const Icon = status.icon;
  const detail = plain(session.error ?? session.lastText);
  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains its own stop button, so it cannot be a <button>
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(session.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen?.(session.id);
      }}
      className={`group relative shrink-0 cursor-pointer overflow-hidden rounded-xl border bg-well-900 p-3 transition ${
        selected
          ? "border-accent-dim"
          : session.status === "needs_you"
            ? "border-needs/60"
            : "border-well-700 hover:border-well-500"
      }`}
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${status.bg}`} />
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-well-50">{session.title}</div>
          <div className="truncate text-xs text-well-400">
            {projectName(session.directory)} · {AGENT_LABELS[session.agent]} · {timeAgo(session.updatedAt)}
          </div>
        </div>
        {session.status === "working" && onStop && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onStop(session.id);
            }}
            className="rounded-md p-1 text-well-500 opacity-0 transition hover:bg-well-800 hover:text-well-50 group-hover:opacity-100"
            title="Stop"
          >
            <Square size={14} />
          </button>
        )}
      </div>
      {/* Idle is the normal state; only spend space on states that matter. */}
      {session.status !== "idle" && (
        <div
          className={`mt-2 flex items-center gap-1.5 pl-1 text-[11px] font-semibold uppercase tracking-wide ${status.color}`}
        >
          <Icon
            size={13}
            className={session.status === "working" ? "animate-spin [animation-duration:2s]" : ""}
          />
          {status.label}
        </div>
      )}
      {detail && <p className="mt-1.5 line-clamp-2 pl-1 text-xs leading-relaxed text-well-400">{detail}</p>}
    </div>
  );
}

/** A session for the trainer screen: one line, big type, status first. */
export function GlanceRow({ session }: { session: AgentSession }) {
  const status = STATUS[session.status];
  const Icon = status.icon;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-well-700 bg-well-900 px-4 py-3">
      <Icon
        size={26}
        className={`shrink-0 ${status.color} ${session.status === "working" ? "animate-spin [animation-duration:2s]" : ""}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-semibold text-well-50">{session.title}</div>
        <div className="truncate text-base text-well-400">
          <span className={`font-semibold ${status.color}`}>{status.label}</span> ·{" "}
          {AGENT_LABELS[session.agent]} · {projectName(session.directory)}
        </div>
      </div>
    </div>
  );
}

/** One line in the conversation that tracks a session's live status. */
export function SessionLine({
  session,
  text,
  onOpen,
  big = false,
}: {
  session?: AgentSession;
  text: string;
  onOpen?: (id: string) => void;
  big?: boolean;
}) {
  const status = session ? STATUS[session.status] : undefined;
  const Icon = status?.icon;
  return (
    <button
      type="button"
      onClick={() => session && onOpen?.(session.id)}
      className={`flex w-full items-start gap-2.5 rounded-xl border border-well-800 bg-well-900/70 px-3 py-2 text-left transition hover:border-well-700 ${big ? "text-lg" : "text-sm"}`}
    >
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
    </button>
  );
}

export function plain(text: string | undefined): string {
  return (text ?? "").replace(/`+/g, "").replace(/\*\*/g, "");
}
