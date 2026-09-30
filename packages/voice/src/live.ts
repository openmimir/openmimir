import type { Caption, VoiceState } from "@openmimir/protocol";
import { VOICE_INSTRUCTIONS } from "./prompt.ts";

const API = "https://api.openai.com/v1";
/** A turn is considered finished after this much transcript silence. */
const TURN_GAP_MS = 1200;
/** Queued announcements wait until nobody has spoken for this long. */
const QUIET_BEFORE_ANNOUNCE_MS = 1500;
/** Roughly 450 tokens; each append is limited to 500. */
const MAX_APPEND_CHARS = 1800;
/** Delegated work shorter than this gets no progress note at all. */
const PROGRESS_AFTER_MS = 6_000;
const PROGRESS_EVERY_MS = 10_000;
/** Reflected microphone audio kept for fallback transcription. */
const AUDIO_BUFFER_MS = 30_000;
/** How far back fallback transcription looks for the request. */
const FALLBACK_WINDOW_MS = 15_000;

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export interface LiveVoiceOptions {
  apiKey: string;
  model: string;
  voice: string;
  /** Handle a delegated request and return what the voice model should say. */
  onDelegation: (utterance: string, progress: (label: string) => void) => Promise<string>;
  onState: (state: VoiceState) => void;
  onCaption: (caption: Caption) => void;
  /** Names worth biasing transcription towards, e.g. project names. */
  vocabulary?: () => string[];
  log?: (message: string) => void;
}

interface Turn {
  text: string;
  lastAt: number;
  consumed: boolean;
}

type LiveEvent = { type: string; [key: string]: unknown };

/**
 * Owns the single active GPT-Live session: creates it from the browser's SDP
 * offer, attaches a server-side sideband socket, assembles transcripts, runs
 * client delegation through the foreman, and injects worker updates.
 */
export class LiveVoice {
  private state: VoiceState = { status: "off" };
  private socket: WebSocket | undefined;
  private sessionId: string | undefined;
  private userTurn: Turn | undefined;
  private mimirTurn: Turn | undefined;
  private unconsumedUser: string[] = [];
  private announcements: string[] = [];
  private ticker: ReturnType<typeof setInterval> | undefined;
  private lastSpeechAt = 0;
  private activeDelegations = 0;
  private closing: { resolve: () => void } | undefined;
  private eventCounter = 0;
  private eventCounts = new Map<string, number>();
  private inputAudio: Array<{ at: number; pcm: Buffer }> = [];
  private lastDelegationAt = 0;

  constructor(private readonly options: LiveVoiceOptions) {}

  get current(): VoiceState {
    return this.state;
  }

  get isLive(): boolean {
    return this.state.status === "live";
  }

  private log(message: string) {
    this.options.log?.(`[voice] ${message}`);
  }

  private setState(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }

  /** Create a WebRTC session from the browser's SDP offer and return the SDP answer. */
  async create(input: { sdp: string; history: HistoryItem[] }): Promise<{ sessionId: string; sdp: string }> {
    if (this.socket) await this.close();
    this.eventCounts = new Map();
    this.inputAudio = [];
    this.lastDelegationAt = Date.now();
    this.setState({ status: "connecting", error: undefined, sessionId: undefined, seconds: 0 });
    const input_ = input.history
      .filter((item) => item.text.trim())
      .slice(-24)
      .map((item) => ({
        type: "message",
        role: item.role,
        content: [
          {
            type: item.role === "user" ? "input_text" : "output_text",
            text: item.text.slice(0, 1200),
          },
        ],
      }));
    const response = await fetch(`${API}/live/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: this.options.model,
          instructions: VOICE_INSTRUCTIONS,
          input: input_,
          audio: { output: { voice: this.options.voice } },
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp: input.sdp },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      const error = `Could not start voice session (${response.status}): ${text.slice(0, 400)}`;
      this.setState({ status: "error", error });
      throw new Error(error);
    }
    const result = (await response.json()) as {
      session: { id: string };
      transport: { sdp: string };
    };
    this.sessionId = result.session.id;
    this.setState({ status: "live", sessionId: this.sessionId, speaking: null, thinking: false });
    this.attach(result.session.id);
    return { sessionId: result.session.id, sdp: result.transport.sdp };
  }

  private attach(sessionId: string) {
    const socket = new WebSocket(`wss://api.openai.com/v1/live/sessions/${sessionId}/attach`, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
    } as unknown as string[]);
    this.socket = socket;
    socket.addEventListener("open", () => this.log(`sideband attached to ${sessionId}`));
    socket.addEventListener("message", (message) => {
      try {
        this.handle(JSON.parse(String(message.data)) as LiveEvent);
      } catch (error) {
        this.log(`bad event: ${error instanceof Error ? error.message : error}`);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.log("sideband closed");
      this.teardown();
    });
    socket.addEventListener("error", () => this.log("sideband error"));
    this.ticker = setInterval(() => this.tick(), 250);
  }

  private send(event: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ event_id: `mimir_${++this.eventCounter}`, ...event }));
    return true;
  }

  private handle(event: LiveEvent) {
    this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1);
    if (process.env.MIMIR_DEBUG && !event.type.includes("audio")) {
      this.log(`event ${JSON.stringify(event).slice(0, 400)}`);
    }
    switch (event.type) {
      case "session.input_audio.append":
        if (typeof event.audio === "string") this.bufferInput(event.audio);
        break;
      case "session.input_transcript.delta":
        this.onTranscript("user", String(event.delta ?? ""));
        break;
      case "session.output_transcript.delta":
        this.onTranscript("mimir", String(event.delta ?? ""));
        break;
      case "session.delegation.created": {
        const delegation = event.delegation as { id?: string; target?: string } | undefined;
        if (delegation?.id && delegation.target === "client") void this.delegate(delegation.id);
        break;
      }
      case "session.usage.updated": {
        const usage = event.usage as { seconds?: number } | undefined;
        if (typeof usage?.seconds === "number") this.setState({ seconds: usage.seconds });
        break;
      }
      case "session.closed":
        this.log(`session closed (${String(event.reason ?? "unknown")})`);
        this.log(`events seen: ${JSON.stringify(Object.fromEntries(this.eventCounts))}`);
        this.closing?.resolve();
        this.teardown();
        break;
      case "error": {
        const error = event.error as { message?: string; code?: string } | undefined;
        this.log(`error: ${error?.code ?? ""} ${error?.message ?? JSON.stringify(event)}`);
        break;
      }
    }
  }

  private onTranscript(speaker: "user" | "mimir", delta: string) {
    if (!delta) return;
    const now = Date.now();
    this.lastSpeechAt = now;
    if (speaker === "user") {
      if (this.mimirTurn) this.finish("mimir");
      this.userTurn ??= { text: "", lastAt: now, consumed: false };
      this.userTurn.text += delta;
      this.userTurn.lastAt = now;
      this.options.onCaption({ speaker, text: this.userTurn.text.trim(), final: false, at: now });
    } else {
      if (this.userTurn) this.finish("user");
      this.mimirTurn ??= { text: "", lastAt: now, consumed: false };
      this.mimirTurn.text += delta;
      this.mimirTurn.lastAt = now;
      this.options.onCaption({ speaker, text: this.mimirTurn.text.trim(), final: false, at: now });
    }
    if (this.state.speaking !== speaker) this.setState({ speaking: speaker });
  }

  private finish(speaker: "user" | "mimir") {
    const turn = speaker === "user" ? this.userTurn : this.mimirTurn;
    if (!turn) return;
    if (speaker === "user") {
      this.userTurn = undefined;
      if (!turn.consumed && turn.text.trim()) this.unconsumedUser.push(turn.text.trim());
    } else {
      this.mimirTurn = undefined;
    }
    this.options.onCaption({ speaker, text: turn.text.trim(), final: true, at: Date.now() });
  }

  private tick() {
    const now = Date.now();
    if (this.userTurn && now - this.userTurn.lastAt > TURN_GAP_MS) this.finish("user");
    if (this.mimirTurn && now - this.mimirTurn.lastAt > TURN_GAP_MS) this.finish("mimir");
    if (!this.userTurn && !this.mimirTurn && this.state.speaking) this.setState({ speaking: null });
    if (this.announcements.length > 0 && now - this.lastSpeechAt > QUIET_BEFORE_ANNOUNCE_MS) {
      const text = this.announcements.splice(0).join(" ");
      this.send({
        type: "session.commentary.append",
        delegation_id: null,
        content: clip(`Background update, tell the user briefly: ${text}`),
      });
    }
  }

  /** Collect what the user said since the last delegation. */
  private takeUtterance(): string {
    const parts = [...this.unconsumedUser];
    this.unconsumedUser = [];
    if (this.userTurn && !this.userTurn.consumed && this.userTurn.text.trim()) {
      parts.push(this.userTurn.text.trim());
      this.userTurn.consumed = true;
    }
    return parts.join(" ").trim();
  }

  private async delegate(delegationId: string) {
    this.activeDelegations++;
    this.setState({ thinking: true });
    const requestedAt = Date.now();
    try {
      // Transcripts can trail the delegation event slightly.
      let utterance = "";
      let transcribedHere = false;
      for (let waited = 0; waited <= 1750 && !utterance; waited += 250) {
        await Bun.sleep(waited === 0 ? 350 : 250);
        utterance = this.takeUtterance();
      }
      if (!utterance) {
        // Live transcription sometimes stays silent; transcribe the mic audio ourselves.
        this.log(`delegation ${delegationId}: no live transcript, transcribing recent audio`);
        transcribedHere = true;
        utterance = await this.transcribeRecent(requestedAt).catch((error) => {
          this.log(`fallback transcription failed: ${error instanceof Error ? error.message : error}`);
          return "";
        });
      }
      this.lastDelegationAt = requestedAt;
      if (utterance && transcribedHere) {
        // Show what was heard, so the user can correct a mishearing.
        this.options.onCaption({ speaker: "user", text: utterance, final: true, at: Date.now() });
      }
      if (!utterance) {
        this.send({
          type: "session.commentary.append",
          delegation_id: delegationId,
          content: "I could not make out the request. Ask the user to repeat it.",
        });
        return;
      }
      this.log(`delegation ${delegationId}: ${utterance}`);
      // Quick lookups finish before a progress note would help; only long work gets one,
      // otherwise the voice model says "still checking" right before the answer lands.
      let lastProgressAt = 0;
      const progress = (label: string) => {
        const now = Date.now();
        if (now - requestedAt < PROGRESS_AFTER_MS || now - lastProgressAt < PROGRESS_EVERY_MS) return;
        lastProgressAt = now;
        this.send({
          type: "session.thinking.append",
          delegation_id: delegationId,
          content: clip(
            `Still working on it: ${label}. Only mention this if the user asks what is happening.`,
          ),
        });
      };
      const answer = await this.options.onDelegation(utterance, progress);
      this.send({ type: "session.commentary.append", delegation_id: delegationId, content: clip(answer) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({
        type: "session.commentary.append",
        delegation_id: delegationId,
        content: clip(`That failed: ${message}`),
      });
    } finally {
      this.activeDelegations--;
      if (this.activeDelegations === 0) this.setState({ thinking: false });
    }
  }

  /** Queue a worker update; it is spoken once the conversation goes quiet. */
  announce(text: string) {
    if (!this.isLive) return;
    this.announcements.push(text);
  }

  private bufferInput(base64: string) {
    const now = Date.now();
    this.inputAudio.push({ at: now, pcm: Buffer.from(base64, "base64") });
    while (this.inputAudio.length > 0 && now - (this.inputAudio[0]?.at ?? now) > AUDIO_BUFFER_MS) {
      this.inputAudio.shift();
    }
  }

  /** Transcribe what the user said just before `until`, since the previous delegation. */
  private async transcribeRecent(until: number): Promise<string> {
    const from = Math.max(this.lastDelegationAt, until - FALLBACK_WINDOW_MS);
    const pcm = Buffer.concat(this.inputAudio.filter((c) => c.at >= from && c.at <= until).map((c) => c.pcm));
    // 24 kHz, 16-bit mono: 48 bytes per millisecond. Skip under half a second or near silence.
    if (pcm.length < 48 * 500 || rms(pcm) < 0.004) return "";
    const form = new FormData();
    form.set("model", "gpt-4o-transcribe");
    form.set("file", new Blob([wav(pcm, 24_000)], { type: "audio/wav" }), "speech.wav");
    const vocabulary = this.options.vocabulary?.() ?? [];
    if (vocabulary.length > 0) {
      form.set(
        "prompt",
        `A developer talking to their coding assistant. Project names: ${vocabulary.join(", ")}.`,
      );
    }
    const response = await fetch(`${API}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    const result = (await response.json()) as { text?: string };
    return result.text?.trim() ?? "";
  }

  /** Quiet context the voice model can use when asked, without speaking it now. */
  context(text: string) {
    if (!this.isLive) return;
    this.send({ type: "session.thinking.append", delegation_id: null, content: clip(text) });
  }

  async close(): Promise<void> {
    if (!this.socket) {
      this.teardown();
      return;
    }
    const closed = new Promise<void>((resolve) => {
      this.closing = { resolve };
    });
    if (this.send({ type: "session.close" })) {
      await Promise.race([closed, Bun.sleep(10_000)]);
    }
    this.teardown();
  }

  private teardown() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.userTurn) this.finish("user");
    if (this.mimirTurn) this.finish("mimir");
    const socket = this.socket;
    this.socket = undefined;
    this.sessionId = undefined;
    this.unconsumedUser = [];
    this.announcements = [];
    this.inputAudio = [];
    this.closing = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (this.state.status !== "error") this.setState({ status: "off", speaking: null, thinking: false });
  }
}

function clip(text: string): string {
  return text.length > MAX_APPEND_CHARS ? `${text.slice(0, MAX_APPEND_CHARS - 1)}…` : text;
}

function rms(pcm: Buffer): number {
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return samples ? Math.sqrt(sum / samples) : 0;
}

/** Wrap raw mono PCM16 in a WAV container. */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
