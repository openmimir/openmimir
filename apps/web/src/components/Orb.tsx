import { useEffect, useRef } from "react";
import type { VoiceLevels } from "../lib/voice";

export type OrbMode = "off" | "connecting" | "listening" | "user" | "speaking" | "thinking" | "error";

const COLORS: Record<OrbMode, string> = {
  off: "#5d6a70",
  connecting: "#36e2c4",
  listening: "#36e2c4",
  user: "#7af0da",
  speaking: "#36e2c4",
  thinking: "#ffb020",
  error: "#ff4d4d",
};

/**
 * Mimir's well: a still pool that ripples when someone speaks. The core swells
 * with microphone or voice level; rings keep moving while live.
 */
export function Orb({
  mode,
  levels,
  size = 56,
}: {
  mode: OrbMode;
  levels?: () => VoiceLevels;
  size?: number;
}) {
  const core = useRef<HTMLDivElement>(null);
  const halo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let smooth = 0;
    const loop = () => {
      const current = levels?.() ?? { mic: 0, out: 0 };
      const target =
        mode === "speaking" ? current.out : mode === "off" ? 0 : Math.max(current.mic, current.out);
      smooth += (target - smooth) * 0.25;
      if (core.current) core.current.style.transform = `scale(${1 + smooth * 0.55})`;
      if (halo.current) halo.current.style.opacity = String(0.15 + smooth * 0.7);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [levels, mode]);

  const color = COLORS[mode];
  const live = mode !== "off" && mode !== "error";

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }} aria-hidden>
      {live && (
        <>
          <span className="ripple absolute inset-0 rounded-full border-2" style={{ borderColor: color }} />
          <span
            className="ripple absolute inset-0 rounded-full border-2"
            style={{ borderColor: color, animationDelay: "0.8s" }}
          />
          <span
            className="ripple absolute inset-0 rounded-full border-2"
            style={{ borderColor: color, animationDelay: "1.6s" }}
          />
        </>
      )}
      <div
        ref={halo}
        className="absolute rounded-full blur-md"
        style={{ width: size * 0.8, height: size * 0.8, background: color, opacity: 0.15 }}
      />
      <div
        ref={core}
        className={`relative rounded-full transition-colors duration-300 ${mode === "thinking" || mode === "connecting" ? "pulse-dot" : ""}`}
        style={{
          width: size * 0.42,
          height: size * 0.42,
          background: live ? color : "transparent",
          border: live ? "none" : `2px solid ${color}`,
          boxShadow: live ? `0 0 ${size * 0.3}px ${color}` : "none",
        }}
      />
    </div>
  );
}
