import { useCallback, useEffect, useMemo, useState } from "react";
import { ApprovalCard } from "./components/ApprovalCard";
import { Orb } from "./components/Orb";
import { useMimir } from "./lib/mimir";
import { useVoice } from "./lib/voice";
import { isVoiceShortcut } from "./lib/voiceUi";
import { Desk } from "./views/Desk";
import { Trainer } from "./views/Trainer";

type Mode = "desk" | "trainer";

function initialMode(): Mode {
  const param = new URLSearchParams(location.search).get("mode");
  if (param === "trainer" || param === "desk") return param;
  return localStorage.getItem("mimir.mode") === "trainer" ? "trainer" : "desk";
}

export function App() {
  const mimir = useMimir();
  const voice = useVoice(mimir.api);
  const [mode, setModeState] = useState<Mode>(initialMode);
  const snapshot = mimir.snapshot;

  const setMode = (next: Mode) => {
    localStorage.setItem("mimir.mode", next);
    setModeState(next);
  };

  const voiceActive = voice.status === "live" || voice.status === "connecting";
  const toggleVoice = useCallback(() => {
    if (voice.status === "live" || voice.status === "connecting") void voice.stop();
    else void voice.start();
  }, [voice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isVoiceShortcut(event)) return;
      event.preventDefault();
      toggleVoice();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleVoice]);

  const sessionsById = useMemo(
    () => new Map((snapshot?.sessions ?? []).map((t) => [t.id, t])),
    [snapshot?.sessions],
  );

  if (mimir.connection === "unpaired") {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <Orb mode="off" size={72} />
          <h1 className="mt-6 text-2xl font-semibold">This device is not paired</h1>
          <p className="mt-2 text-well-400">
            Run <code className="rounded bg-well-800 px-1.5 py-0.5 font-mono">mimir pair</code> on the Mac
            running Mimir and open the link here.
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="grid h-full place-items-center">
        <Orb mode="connecting" size={72} />
      </div>
    );
  }

  const approvals = snapshot.approvals.map((approval) => (
    <ApprovalCard
      key={approval.id}
      big={mode === "trainer"}
      approval={approval}
      session={sessionsById.get(approval.sessionId)}
      onResolve={mimir.resolveApproval}
    />
  ));

  const View = mode === "trainer" ? Trainer : Desk;
  return (
    <View
      snapshot={snapshot}
      sessionsById={sessionsById}
      mimir={mimir}
      voice={voice}
      voiceActive={voiceActive}
      toggleVoice={toggleVoice}
      setMode={setMode}
      approvals={approvals}
    />
  );
}
