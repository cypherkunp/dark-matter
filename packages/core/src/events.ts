import { EventEmitter, on } from "node:events";
import type { CoreEvent } from "@dark-matter/contracts";

/** Fans core events out to every `events` subscriber. */
export class EventBus {
  readonly #emitter = new EventEmitter().setMaxListeners(0);

  publish(event: CoreEvent): void {
    this.#emitter.emit("event", event);
  }

  async *subscribe(signal: AbortSignal): AsyncIterable<CoreEvent> {
    try {
      for await (const [event] of on(this.#emitter, "event", { signal })) {
        yield event as CoreEvent;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
