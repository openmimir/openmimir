import { type Approval, type ApprovalDecision, describeAction, type Task } from "@openmimir/protocol";
import { Check, Mic, Monitor, X } from "lucide-react";
import { useState } from "react";

export function ApprovalCard({
  approval,
  task,
  big = false,
  onResolve,
}: {
  approval: Approval;
  task?: Task;
  big?: boolean;
  onResolve: (id: string, decision: ApprovalDecision) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const resolve = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await onResolve(approval.id, decision);
    } finally {
      setBusy(false);
    }
  };
  const TierIcon = approval.tier === "screen" ? Monitor : Mic;
  return (
    <div className={`rounded-xl border border-needs/50 bg-needs/[0.07] ${big ? "p-6" : "p-3"}`}>
      <div className={`flex items-center justify-between gap-2 ${big ? "text-base" : "text-[11px]"}`}>
        <span className="font-semibold uppercase tracking-wide text-needs">Approval needed</span>
        <span
          className="flex items-center gap-1 text-well-400"
          title={
            approval.tier === "screen" ? "Only approvable on a screen" : "Approvable by voice with 'confirm'"
          }
        >
          <TierIcon size={big ? 16 : 12} />
          {approval.tier === "screen" ? "screen only" : "voice ok"}
        </span>
      </div>
      <div className={`mt-1 font-semibold text-well-50 ${big ? "text-3xl" : "text-sm"}`}>
        {task?.title ?? "A task"} wants to{" "}
        <span className="text-needs">{describeAction(approval.action, [])}</span>
      </div>
      {approval.resources.length > 0 && (
        <pre
          className={`mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-well-950/70 p-2 font-mono text-well-200 scroll-thin ${big ? "text-lg" : "text-xs"}`}
        >
          {approval.resources.join("\n")}
        </pre>
      )}
      {approval.message && (
        <p className={`mt-2 text-well-400 ${big ? "text-lg" : "text-xs"}`}>{approval.message}</p>
      )}
      <div className={`mt-3 grid grid-cols-2 gap-2 ${big ? "mt-5 gap-4" : ""}`}>
        <button
          type="button"
          disabled={busy}
          onClick={() => resolve("reject")}
          className={`flex items-center justify-center gap-2 rounded-lg border border-well-700 bg-well-850 font-semibold text-well-50 transition hover:bg-well-800 disabled:opacity-50 ${big ? "py-6 text-2xl" : "py-2 text-sm"}`}
        >
          <X size={big ? 28 : 16} /> Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => resolve("approve")}
          className={`flex items-center justify-center gap-2 rounded-lg bg-done font-semibold text-well-950 transition hover:brightness-110 disabled:opacity-50 ${big ? "py-6 text-2xl" : "py-2 text-sm"}`}
        >
          <Check size={big ? 28 : 16} /> Approve
        </button>
      </div>
    </div>
  );
}
