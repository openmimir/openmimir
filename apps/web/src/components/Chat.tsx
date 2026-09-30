import type { AgentSession, ChatMessage } from "@openmimir/protocol";
import { ArrowUp, Mic, Radio } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SessionLine } from "./SessionCard";
import { Steps } from "./Steps";

/** One entry in the conversation. `big` is used on the trainer screen. */
export function MessageView({
  message,
  sessions,
  onOpenSession,
  big = false,
}: {
  message: ChatMessage;
  sessions: Map<string, AgentSession>;
  onOpenSession?: (id: string) => void;
  big?: boolean;
}) {
  if (message.role === "notice" && message.sessionId) {
    return (
      <SessionLine
        session={sessions.get(message.sessionId)}
        text={message.text}
        onOpen={onOpenSession}
        big={big}
      />
    );
  }
  if (message.role === "notice") {
    return (
      <div
        className={`flex gap-2 border-l-2 border-accent-dim py-0.5 pl-3 text-well-400 ${big ? "text-lg" : "text-sm"}`}
      >
        <Radio size={14} className="mt-0.5 shrink-0 text-accent" />
        <span>{message.text.replace(/`+/g, "")}</span>
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[85%] rounded-2xl rounded-br-md bg-well-800 px-4 py-2.5 leading-relaxed text-well-50 ${big ? "text-xl" : "text-[15px]"}`}
        >
          {message.source === "voice" && <Mic size={12} className="mb-1 text-accent" />}
          <div className="whitespace-pre-wrap">{message.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="mt-1.5 size-2.5 shrink-0 rounded-full bg-accent shadow-[0_0_10px] shadow-accent/60" />
      <div className="min-w-0 flex-1">
        {message.steps && message.steps.length > 0 && (
          <Steps steps={message.steps} sessions={sessions} onOpenSession={onOpenSession} big={big} />
        )}
        <div className={`prose-mimir leading-relaxed text-well-200 ${big ? "text-xl" : "text-[15px]"}`}>
          {message.text ? (
            <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
          ) : (
            !message.steps?.length && <span className="pulse-dot text-well-500">…</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Chat({
  messages,
  sessions,
  onSend,
  voiceButton,
  aboveComposer,
  onOpenSession,
}: {
  messages: ChatMessage[];
  sessions: Map<string, AgentSession>;
  onSend: (text: string) => Promise<unknown>;
  voiceButton: React.ReactNode;
  aboveComposer?: React.ReactNode;
  onOpenSession?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const last = messages[messages.length - 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the last message grows
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, last?.text]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "TEXTAREA") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    setError(null);
    try {
      await onSend(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setText(value);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
          {messages.length === 0 && (
            <div className="mt-[18vh] text-center">
              <div className="text-3xl font-semibold tracking-tight text-well-50">
                What should your agents do?
              </div>
              <p className="mx-auto mt-3 max-w-lg text-well-400">
                Mimir already sees your recent OpenCode, Claude Code and Codex sessions. Try “How is the
                reachkit work going?” or “Add a setup section to the openmimir README.”
              </p>
            </div>
          )}
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              sessions={sessions}
              onOpenSession={onOpenSession}
            />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <form onSubmit={submit} className="mx-auto w-full max-w-3xl px-5 pb-5">
        {aboveComposer}
        {error && <div className="mb-2 text-sm text-failed">{error}</div>}
        <div className="flex items-end gap-2 rounded-2xl border border-well-700 bg-well-900 p-2 focus-within:border-accent-dim">
          {voiceButton}
          <textarea
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Message Mimir…  ( / to focus )"
            className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-well-50 outline-none placeholder:text-well-500"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="grid size-10 place-items-center rounded-xl bg-accent text-well-950 transition hover:brightness-110 disabled:bg-well-800 disabled:text-well-500"
            title="Send (Enter)"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
