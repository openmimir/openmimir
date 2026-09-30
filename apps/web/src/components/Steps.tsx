import { AGENT_LABELS, type AgentSession, type ForemanStep } from "@openmimir/protocol";
import { AlertTriangle, Check, ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { projectName, STATUS } from "../lib/format";

/** A clickable pill for a session, showing its live status. */
export function SessionChip({
  session,
  onOpen,
  big = false,
}: {
  session: AgentSession;
  onOpen?: (id: string) => void;
  big?: boolean;
}) {
  const status = STATUS[session.status];
  return (
    <button
      type="button"
      onClick={() => onOpen?.(session.id)}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-well-700 bg-well-850 text-left transition hover:border-well-500 ${
        big ? "px-3 py-1 text-base" : "px-2 py-0.5 text-xs"
      }`}
      title={`${session.title} · ${AGENT_LABELS[session.agent]} · ${projectName(session.directory)}`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${status.bg} ${session.status === "working" ? "pulse-dot" : ""}`}
      />
      <span className="truncate text-well-200">{session.title}</span>
      <span className="shrink-0 text-well-500">
        {AGENT_LABELS[session.agent]} · {projectName(session.directory)}
      </span>
    </button>
  );
}

function StepRow({
  step,
  session,
  onOpenSession,
  big,
}: {
  step: ForemanStep;
  session?: AgentSession;
  onOpenSession?: (id: string) => void;
  big: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = step.state === "running" ? LoaderCircle : step.state === "error" ? AlertTriangle : Check;
  const color =
    step.state === "running" ? "text-working" : step.state === "error" ? "text-failed" : "text-well-500";
  return (
    <li className={big ? "text-lg" : "text-[13px]"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon
          size={big ? 18 : 13}
          className={`shrink-0 ${color} ${step.state === "running" ? "animate-spin" : ""}`}
        />
        <button
          type="button"
          onClick={() => step.detail && setOpen(!open)}
          className={`flex items-center gap-1 text-left text-well-400 ${step.detail ? "hover:text-well-200" : "cursor-default"}`}
        >
          {step.label}
          {step.detail && (
            <ChevronRight size={12} className={`shrink-0 transition ${open ? "rotate-90" : ""}`} />
          )}
        </button>
        {session && <SessionChip session={session} onOpen={onOpenSession} big={big} />}
      </div>
      {step.message && <SentMessage text={step.message} big={big} />}
      {open && step.detail && (
        <pre className="mt-1.5 ml-5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-well-800 bg-well-950 p-2.5 font-mono text-xs text-well-400 scroll-thin">
          {step.detail}
        </pre>
      )}
    </li>
  );
}

/** The exact message Mimir sent to a session, always visible; long ones expand on click. */
function SentMessage({ text, big }: { text: string; big: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={`mt-1 ml-5 flex w-[calc(100%-1.25rem)] items-start gap-1 text-left text-well-500 hover:text-well-400 ${
        big ? "text-base" : "text-xs"
      }`}
      title={expanded ? "Show less" : "Show what Mimir sent"}
    >
      <ChevronRight size={12} className={`mt-0.5 shrink-0 transition ${expanded ? "rotate-90" : ""}`} />
      <span className={expanded ? "whitespace-pre-wrap text-well-400" : "truncate"}>{text}</span>
    </button>
  );
}

/** What the foreman did for a reply: every session it read, messaged or started. */
export function Steps({
  steps,
  sessions,
  onOpenSession,
  big = false,
}: {
  steps: ForemanStep[];
  sessions: Map<string, AgentSession>;
  onOpenSession?: (id: string) => void;
  big?: boolean;
}) {
  if (steps.length === 0) return null;
  return (
    <ul className={`flex flex-col border-l border-well-800 pl-3 ${big ? "mb-3 gap-2" : "mb-2 gap-1.5"}`}>
      {steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          session={step.sessionId ? sessions.get(step.sessionId) : undefined}
          onOpenSession={onOpenSession}
          big={big}
        />
      ))}
    </ul>
  );
}
