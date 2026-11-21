import { EventEmitter, on } from "node:events";
import type { CoreEvent, Domain } from "@dark-matter/contracts";

/** What the overview screens (#45) are computed from: when any of these change, so does `overview`. */
const overviewInputs = new Set<Domain>(["scan", "inbox", "project", "library"]);

/** Adds the domains computed from the changed ones, so every publisher needn't know about them. */
const withDerived = (event: CoreEvent): CoreEvent =>
  event.domains.includes("overview") || !event.domains.some((domain) => overviewInputs.has(domain))
    ? event
    : { ...event, domains: [...event.domains, "overview"] };

/** Fans core events out to every `events` subscriber. */
export class EventBus {
  readonly #emitter = new EventEmitter().setMaxListeners(0);

  publish(event: CoreEvent): void {
    this.#emitter.emit("event", withDerived(event));
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
