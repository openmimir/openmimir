import type { AgentSession, ChatMessage } from "@openmimir/protocol";
import { useEffect, useRef } from "react";
import { MessageView } from "./Chat";

/** The last few turns of the conversation, readable from the saddle. */
export function TrainerFeed({
  messages,
  sessions,
}: {
  messages: ChatMessage[];
  sessions: Map<string, AgentSession>;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const recent = messages.slice(-8);
  const last = recent[recent.length - 1];

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the conversation as it grows
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [recent.length, last?.text, last?.steps?.length]);

  return (
    <section className="scroll-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto rounded-2xl border border-well-800 bg-well-900/40 p-5">
      {recent.length === 0 ? (
        <div className="m-auto text-center text-2xl text-well-500">
          Talk to Mimir. The conversation shows up here.
        </div>
      ) : (
        recent.map((message) => <MessageView key={message.id} message={message} sessions={sessions} big />)
      )}
      <div ref={bottom} />
    </section>
  );
}
