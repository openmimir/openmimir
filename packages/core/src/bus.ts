import type { ServerEvent } from "@openmimir/protocol";

type Listener = (event: ServerEvent) => void;

/** In-process fan-out of server events to every connected interface. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[bus] listener failed", error);
      }
    }
  }
}

export function newId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${Date.now().toString(36)}${Buffer.from(random).toString("hex").slice(0, 10)}`;
}
