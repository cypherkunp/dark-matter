import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The core's one write queue (review #8): every operation that changes the
 * Library (Adopt and Undo, Rename Namespace, Import and updates, delete, edits,
 * MCP definitions, Project deliveries) runs on it, one at a time, so two of
 * them never interleave. A task already on the queue that calls another
 * queued operation runs it inline instead of waiting behind itself.
 */
export class WriteQueue {
  #tail: Promise<unknown> = Promise.resolve();
  readonly #inside = new AsyncLocalStorage<true>();

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#inside.getStore()) return task();
    const start = () => this.#inside.run(true, task);
    const run = this.#tail.then(start, start);
    this.#tail = run.catch(() => {});
    return run;
  }
}
