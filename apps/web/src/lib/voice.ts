import { useCallback, useEffect, useRef, useState } from "react";
import type { MimirApi } from "./mimir";

export type LocalVoiceStatus = "idle" | "connecting" | "live" | "ending" | "error";

export interface VoiceLevels {
  mic: number;
  out: number;
}

function meter(context: AudioContext, stream: MediaStream) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  return () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  };
}

/**
 * Browser side of a GPT-Live session: microphone + speaker over WebRTC,
 * straight to OpenAI. The Mimir server brokers the session and listens in.
 */
export function useVoice(api: MimirApi) {
  const [status, setStatus] = useState<LocalVoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const peer = useRef<RTCPeerConnection | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const context = useRef<AudioContext | null>(null);
  const meters = useRef<{ mic?: () => number; out?: () => number }>({});

  const cleanup = useCallback(() => {
    for (const track of mic.current?.getTracks() ?? []) track.stop();
    peer.current?.close();
    void context.current?.close();
    if (audio.current) audio.current.srcObject = null;
    mic.current = null;
    peer.current = null;
    context.current = null;
    meters.current = {};
    setMuted(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    if (peer.current) return;
    setError(null);
    setStatus("connecting");
    try {
      const connection = new RTCPeerConnection();
      peer.current = connection;
      context.current = new AudioContext();

      audio.current ??= new Audio();
      audio.current.autoplay = true;
      connection.addEventListener("track", (event) => {
        const stream = new MediaStream([event.track]);
        if (audio.current) {
          audio.current.srcObject = stream;
          void audio.current.play().catch(() => undefined);
        }
        if (context.current) meters.current.out = meter(context.current, stream);
      });

      mic.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const track of mic.current.getAudioTracks()) connection.addTrack(track, mic.current);
      meters.current.mic = meter(context.current, mic.current);

      const events = connection.createDataChannel("oai-events");
      events.addEventListener("message", ({ data }) => {
        try {
          const event = JSON.parse(data) as { type: string };
          if (event.type === "session.started") setStatus("live");
          if (event.type === "session.closed") {
            cleanup();
            setStatus("idle");
          }
        } catch {
          // Ignore non-JSON frames.
        }
      });
      events.addEventListener("close", () => {
        if (peer.current === connection) {
          cleanup();
          setStatus("idle");
        }
      });
      connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed") {
          cleanup();
          setError("Voice connection lost.");
          setStatus("error");
        }
      });

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        if (connection.iceGatheringState === "complete") return resolve();
        const timeout = setTimeout(resolve, 3000);
        connection.addEventListener("icegatheringstatechange", () => {
          if (connection.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("Could not create a connection offer.");
      const result = await api.request<{ sdp: string }>("/api/voice/session", { sdp });
      await connection.setRemoteDescription({ type: "answer", sdp: result.sdp });
      setStatus("live");
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [api, cleanup]);

  const stop = useCallback(async () => {
    setStatus("ending");
    try {
      await api.request("/api/voice/close", {});
    } finally {
      cleanup();
      setStatus("idle");
    }
  }, [api, cleanup]);

  const toggleMute = useCallback(() => {
    const tracks = mic.current?.getAudioTracks() ?? [];
    const next = !muted;
    for (const track of tracks) track.enabled = !next;
    setMuted(next);
  }, [muted]);

  const levels = useCallback(
    (): VoiceLevels => ({ mic: muted ? 0 : (meters.current.mic?.() ?? 0), out: meters.current.out?.() ?? 0 }),
    [muted],
  );

  return { status, error, muted, start, stop, toggleMute, levels };
}
