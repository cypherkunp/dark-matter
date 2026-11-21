import { EventEmitter, on } from "node:events";
import type { CoreNotification } from "@dark-matter/contracts";

/** Shows OS notifications. The core can't (it has no Electron), so by default it asks the app. */
export interface Notifier {
  notify(notification: CoreNotification): void;
  /** Whether anyone is there to see it now (the app); unknown counts as yes. */
  available?(): boolean;
}

/**
 * Fans notifications out to `notifications` subscribers; Electron main shows
 * them (ADR-0003: IPC only for native things).
 */
export class NotificationBus implements Notifier {
  readonly #emitter = new EventEmitter().setMaxListeners(0);

  notify(notification: CoreNotification): void {
    this.#emitter.emit("notification", notification);
  }

  /** The app subscribes while it runs; a headless core has no one to ask. */
  available(): boolean {
    return this.#emitter.listenerCount("notification") > 0;
  }

  async *subscribe(signal: AbortSignal): AsyncIterable<CoreNotification> {
    try {
      for await (const [notification] of on(this.#emitter, "notification", { signal })) {
        yield notification as CoreNotification;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
