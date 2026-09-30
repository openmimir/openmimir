import type {
  AgentSession,
  Approval,
  ApprovalDecision,
  Caption,
  ChatMessage,
  ServerEvent,
  Snapshot,
} from "@openmimir/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unpaired";

export interface MimirState {
  snapshot: Snapshot | null;
  captions: { user?: Caption; mimir?: Caption };
}

type Action = { type: "event"; event: ServerEvent };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function reducer(state: MimirState, action: Action): MimirState {
  const event = action.event;
  if (event.type === "snapshot") return { ...state, snapshot: event.snapshot };
  if (event.type === "caption") {
    return { ...state, captions: { ...state.captions, [event.caption.speaker]: event.caption } };
  }
  const snapshot = state.snapshot;
  if (!snapshot) return state;
  switch (event.type) {
    case "message.upsert":
      return {
        ...state,
        snapshot: { ...snapshot, messages: upsert<ChatMessage>(snapshot.messages, event.message) },
      };
    case "session.upsert": {
      const sessions = upsert<AgentSession>(snapshot.sessions, event.session).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      return { ...state, snapshot: { ...snapshot, sessions } };
    }
    case "sessions.replace":
      return { ...state, snapshot: { ...snapshot, sessions: event.sessions } };
    case "approval.upsert": {
      const approvals = upsert<Approval>(snapshot.approvals, event.approval).filter(
        (a) => a.status === "pending",
      );
      return { ...state, snapshot: { ...snapshot, approvals } };
    }
    case "voice.state":
      return { ...state, snapshot: { ...snapshot, voice: event.voice } };
    case "info":
      return { ...state, snapshot: { ...snapshot, info: event.info } };
  }
  return state;
}

export interface MimirApi {
  token: string | null;
  request: <T = unknown>(path: string, body?: unknown) => Promise<T>;
}

export function useMimir() {
  const [state, dispatch] = useReducer(reducer, { snapshot: null, captions: {} });
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [token, setToken] = useState<string | null>(null);
  const versionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;

    async function connect() {
      if (cancelled) return;
      setConnection("connecting");
      try {
        const response = await fetch("/api/bootstrap");
        if (response.status === 401) {
          setConnection("unpaired");
          return;
        }
        const { token } = (await response.json()) as { token: string };
        if (cancelled) return;
        setToken(token);
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${protocol}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
        socket.onopen = () => {
          delay = 500;
          setConnection("open");
        };
        socket.onmessage = (message) => {
          const event = JSON.parse(message.data) as ServerEvent;
          if (event.type === "snapshot") {
            // Reload after the server was upgraded so the UI matches it.
            const version = event.snapshot.info.version;
            if (versionRef.current && versionRef.current !== version) location.reload();
            versionRef.current = version;
          }
          dispatch({ type: "event", event });
        };
        socket.onclose = () => {
          setConnection("closed");
          schedule();
        };
      } catch {
        setConnection("closed");
        schedule();
      }
    }

    function schedule() {
      if (cancelled) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    }

    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const request = useCallback(
    async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-mimir-token": token ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as T & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
      return data;
    },
    [token],
  );

  const sendChat = useCallback((text: string) => request("/api/chat", { text }), [request]);
  const resolveApproval = useCallback(
    (id: string, decision: ApprovalDecision) => request(`/api/approvals/${id}`, { decision }),
    [request],
  );
  const latestText = useCallback(
    async (id: string) =>
      (await request<{ text: string | null }>(`/api/sessions/${encodeURIComponent(id)}/latest`)).text,
    [request],
  );
  const stopSession = useCallback(
    (id: string) => request(`/api/sessions/${encodeURIComponent(id)}/stop`, {}),
    [request],
  );

  return {
    ...state,
    connection,
    api: { token, request } as MimirApi,
    sendChat,
    resolveApproval,
    stopSession,
    latestText,
  };
}
