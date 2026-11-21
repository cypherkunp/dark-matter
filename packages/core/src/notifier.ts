import { EventEmitter, on } from "node:events";
import type { CoreNotification } from "@dark-matter/contracts";

/** Shows OS notifications. The core can't (it has no Electron), so by default it asks the app. */
export interface Notifier {
  notify(notification: CoreNotification): void;
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
