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

  /** Tells clients these domains changed (review #22: one helper instead of hand-written events). */
  invalidate(...domains: [Domain, ...Domain[]]): void {
    this.publish({ type: "invalidate", domains });
  }

  /** An `onChange` callback that invalidates these domains. */
  invalidator(...domains: [Domain, ...Domain[]]): () => void {
    return () => this.invalidate(...domains);
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
