import type { Snapshot } from "@openmimir/protocol";
import type { OrbMode } from "../components/Orb";
import type { LocalVoiceStatus } from "./voice";

// Ctrl+Space switches keyboard input sources on macOS, and Cmd+Space is Spotlight.
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
export const VOICE_SHORTCUT = IS_MAC ? "⌘⇧Space" : "Ctrl+Shift+Space";

export function isVoiceShortcut(event: KeyboardEvent): boolean {
  return (IS_MAC ? event.metaKey : event.ctrlKey) && event.shiftKey && event.code === "Space";
}

/** Combine the browser's connection state with what the server hears. */
export function orbMode(snapshot: Snapshot, local: LocalVoiceStatus): OrbMode {
  if (local === "connecting") return "connecting";
  if (local === "error") return "error";
  const voice = snapshot.voice;
  if (voice.status !== "live") return local === "live" ? "listening" : "off";
  if (voice.thinking && voice.speaking !== "mimir") return "thinking";
  if (voice.speaking === "mimir") return "speaking";
  if (voice.speaking === "user") return "user";
  return "listening";
}

export const ORB_LABEL: Record<OrbMode, string> = {
  off: "Voice off",
  connecting: "Connecting…",
  listening: "Listening",
  user: "Hearing you",
  speaking: "Speaking",
  thinking: "Working on it",
  error: "Voice error",
};
