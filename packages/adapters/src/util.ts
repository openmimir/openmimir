import type { AdapterEvent } from "./types.ts";

/** Listener fan-out shared by all adapters. */
export class Emitter {
  private readonly listeners = new Set<(event: AdapterEvent) => void>();

  onEvent(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: AdapterEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[adapter] listener failed", error);
      }
    }
  }
}

/** Yield complete lines from a byte stream, e.g. a child process's stdout. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/** Read the first and last `bytes` of a file without loading all of it. */
export async function headAndTail(path: string, bytes: number): Promise<{ head: string; tail: string }> {
  const file = Bun.file(path);
  const size = file.size;
  const head = await file.slice(0, Math.min(size, bytes)).text();
  const tail = size <= bytes ? head : await file.slice(Math.max(0, size - bytes), size).text();
  return { head, tail };
}

export function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Partial line at a slice boundary.
    }
  }
  return out;
}

export function oneLine(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
