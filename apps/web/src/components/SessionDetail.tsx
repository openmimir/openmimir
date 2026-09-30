import { AGENT_LABELS, type AgentSession } from "@openmimir/protocol";
import { Square, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { projectName, STATUS, timeAgo } from "../lib/format";

/** Everything Mimir knows about one session: status and the last thing its agent said. */
export function SessionDetail({
  session,
  onClose,
  onStop,
}: {
  session: AgentSession;
  onClose: () => void;
  onStop?: (id: string) => void;
}) {
  const status = STATUS[session.status];
  const Icon = status.icon;
  return (
    <div className="flex min-h-0 flex-col gap-3 rounded-xl border border-well-700 bg-well-900 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-well-50">{session.title}</div>
          <div className="mt-0.5 text-xs text-well-400">
            {AGENT_LABELS[session.agent]} · {projectName(session.directory)} · {timeAgo(session.updatedAt)}
            {session.origin === "external" && " · started outside Mimir"}
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-well-500 hover:text-well-50" title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center justify-between">
        <span
          className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${status.color}`}
        >
          <Icon
            size={13}
            className={session.status === "working" ? "animate-spin [animation-duration:2s]" : ""}
          />
          {status.label}
        </span>
        {session.status === "working" && onStop && (
          <button
            type="button"
            onClick={() => onStop(session.id)}
            className="flex items-center gap-1 rounded-md border border-well-700 px-2 py-0.5 text-xs text-well-400 hover:text-well-50"
          >
            <Square size={11} /> Stop
          </button>
        )}
      </div>
      {session.error && <div className="text-sm text-failed">{session.error}</div>}
      {session.lastText ? (
        <div className="scroll-thin min-h-0 overflow-y-auto">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-well-500">
            Last message
          </div>
          <div className="prose-mimir text-sm leading-relaxed text-well-200">
            <Markdown remarkPlugins={[remarkGfm]}>{session.lastText}</Markdown>
          </div>
        </div>
      ) : (
        <div className="text-sm text-well-500">No messages seen yet.</div>
      )}
      <div className="truncate font-mono text-[11px] text-well-500" title={session.directory}>
        {session.directory}
      </div>
    </div>
  );
}
