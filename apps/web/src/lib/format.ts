import type { WorkerStatus } from "@openmimir/protocol";
import { AlertTriangle, CheckCircle2, CircleDashed, Hand, LoaderCircle, type LucideIcon } from "lucide-react";

export const STATUS: Record<WorkerStatus, { label: string; color: string; bg: string; icon: LucideIcon }> = {
  working: { label: "Working", color: "text-working", bg: "bg-working", icon: LoaderCircle },
  needs_you: { label: "Needs you", color: "text-needs", bg: "bg-needs", icon: Hand },
  done: { label: "Done", color: "text-done", bg: "bg-done", icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-failed", bg: "bg-failed", icon: AlertTriangle },
  idle: { label: "Idle", color: "text-idle", bg: "bg-idle", icon: CircleDashed },
};

export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function projectName(directory: string): string {
  return directory.split("/").filter(Boolean).pop() ?? directory;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
