import type { Worker } from "@openmimir/protocol";
import { Square } from "lucide-react";
import { projectName, STATUS, timeAgo } from "../lib/format";

export function WorkerCard({
  worker,
  big = false,
  onStop,
}: {
  worker: Worker;
  big?: boolean;
  onStop?: (id: string) => void;
}) {
  const status = STATUS[worker.status];
  const Icon = status.icon;
  return (
    <div
      className={`group relative overflow-hidden rounded-xl border bg-well-900 ${
        worker.status === "needs_you" ? "border-needs/60" : "border-well-700"
      } ${big ? "p-5" : "p-3"}`}
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${status.bg}`} />
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="min-w-0">
          <div className={`truncate font-semibold text-well-50 ${big ? "text-2xl" : "text-sm"}`}>
            {worker.title}
          </div>
          <div className={`truncate text-well-400 ${big ? "text-base" : "text-xs"}`}>
            {projectName(worker.directory)} · {timeAgo(worker.updatedAt)}
          </div>
        </div>
        {worker.status === "working" && onStop && !big && (
          <button
            type="button"
            onClick={() => onStop(worker.id)}
            className="rounded-md p-1 text-well-500 opacity-0 transition hover:bg-well-800 hover:text-well-50 group-hover:opacity-100"
            title="Stop worker"
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
          className={worker.status === "working" ? "animate-spin [animation-duration:2s]" : ""}
        />
        {status.label}
      </div>
      {worker.lastText && !big && (
        <p className="mt-1.5 line-clamp-2 pl-1 text-xs leading-relaxed text-well-400">
          {plain(worker.error ?? worker.lastText)}
        </p>
      )}
      {big && (worker.error || worker.lastText) && (
        <p className="mt-2 line-clamp-3 pl-1 text-lg leading-snug text-well-200">
          {plain(worker.error ?? worker.lastText)}
        </p>
      )}
    </div>
  );
}

function plain(text: string | undefined): string {
  return (text ?? "").replace(/`+/g, "").replace(/\*\*/g, "");
}
