import type { AgentSession, Snapshot } from "@openmimir/protocol";
import type { ReactNode } from "react";
import type { useMimir } from "../lib/mimir";
import type { useVoice } from "../lib/voice";

/** Everything a screen needs from the app shell. */
export interface ViewProps {
  snapshot: Snapshot;
  sessionsById: Map<string, AgentSession>;
  mimir: ReturnType<typeof useMimir>;
  voice: ReturnType<typeof useVoice>;
  voiceActive: boolean;
  toggleVoice: () => void;
  setMode: (mode: "desk" | "trainer") => void;
  /** Approval cards, already rendered at the right size for the screen. */
  approvals: ReactNode[];
}
