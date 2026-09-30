import type { Caption } from "@openmimir/protocol";

/**
 * What Mimir hears, word by word while you speak, so a mishearing is visible
 * right away and you can correct it before it acts.
 */
export function LiveCaptions({
  user,
  mimir,
  big = false,
}: {
  user?: Caption;
  mimir?: Caption;
  big?: boolean;
}) {
  // The newest caption goes last; older turns fade out after a while.
  const recent = (c?: Caption) => c && Date.now() - c.at < 20_000;
  const lines = [user, mimir].filter(recent).sort((a, b) => (a?.at ?? 0) - (b?.at ?? 0)) as Caption[];
  if (lines.length === 0) {
    return (
      <div className={`text-well-500 ${big ? "text-xl" : "text-sm"}`}>
        Listening. What you say shows up here.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {lines.map((caption) => (
        <div
          key={caption.speaker}
          className={`${big ? "text-xl" : "text-sm"} ${
            caption.speaker === "user"
              ? caption.final
                ? "text-well-400"
                : "text-well-50"
              : caption.final
                ? "text-well-200"
                : "text-accent"
          }`}
        >
          <span
            className={`mr-2 font-semibold ${caption.speaker === "user" ? "text-well-500" : "text-accent-dim"}`}
          >
            {caption.speaker === "user" ? (caption.final ? "Heard" : "Hearing") : "Mimir"}
          </span>
          {caption.text}
          {!caption.final && <span className="pulse-dot ml-0.5">▍</span>}
        </div>
      ))}
    </div>
  );
}
