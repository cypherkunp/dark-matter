import { stat } from "node:fs/promises";
import type { AsyncSubscription } from "@parcel/watcher";

/** One folder watched recursively; `ignore` are paths relative to it, or globs. */
export interface WatchRoot {
  path: string;
  ignore?: readonly string[];
}

export interface FolderWatcherOptions {
  /** One call per burst: every path that changed, created or was deleted, deduplicated. */
  onChanges(paths: string[]): void;
  onError(error: unknown): void;
  /** Quiet time that ends a burst. */
  debounceMs?: number;
  /** A burst never waits longer than this. */
  maxWaitMs?: number;
}

const isDirectory = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

const key = (root: WatchRoot) => `${root.path}\0${[...(root.ignore ?? [])].join("\0")}`;

/**
 * Live refresh (#42): watches folders recursively with `@parcel/watcher`
 * (FSEvents on macOS, inotify on Linux; N-API, so the same binary runs under
 * Electron's Node) and reports changes in debounced bursts. Folders that don't
 * exist yet are skipped until a later `sync` finds them.
 */
export class FolderWatcher {
  readonly #options: FolderWatcherOptions;
  readonly #subscriptions = new Map<string, Promise<AsyncSubscription | null>>();
  readonly #pending = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #firstAt = 0;
  #closed = false;
  #sync: Promise<void> = Promise.resolve();

  constructor(options: FolderWatcherOptions) {
    this.#options = options;
  }

  /** Watches exactly `roots` from now on (serialised; the latest call wins). */
  sync(roots: readonly WatchRoot[]): Promise<void> {
    const run = async () => {
      if (this.#closed) return;
      const wanted = new Map<string, WatchRoot>();
      for (const root of roots) if (await isDirectory(root.path)) wanted.set(key(root), root);
      for (const [id, subscription] of this.#subscriptions) {
        if (wanted.has(id)) continue;
        this.#subscriptions.delete(id);
        await this.#unsubscribe(subscription);
      }
      for (const [id, root] of wanted) {
        if (this.#subscriptions.has(id)) continue;
        this.#subscriptions.set(id, this.#subscribe(root));
      }
      await Promise.all(this.#subscriptions.values());
    };
    this.#sync = this.#sync.then(run, run);
    return this.#sync;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#sync.catch(() => {});
    if (this.#timer) clearTimeout(this.#timer);
    const all = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    await Promise.all(all.map((subscription) => this.#unsubscribe(subscription)));
  }

  async #subscribe(root: WatchRoot): Promise<AsyncSubscription | null> {
    try {
      const { subscribe } = await import("@parcel/watcher");
      return await subscribe(
        root.path,
        (error, events) => {
          if (error) this.#options.onError(error);
          this.#add(events.map((event) => event.path));
        },
        { ignore: [...(root.ignore ?? [])] },
      );
    } catch (error) {
      this.#options.onError(error);
      return null;
    }
  }

  async #unsubscribe(subscription: Promise<AsyncSubscription | null>) {
    await (await subscription)?.unsubscribe().catch((error: unknown) => this.#options.onError(error));
  }

  #add(paths: readonly string[]) {
    if (this.#closed || paths.length === 0) return;
    for (const path of paths) this.#pending.add(path);
    const now = Date.now();
    if (!this.#timer) this.#firstAt = now;
    if (this.#timer) clearTimeout(this.#timer);
    const { debounceMs = 100, maxWaitMs = 1000 } = this.#options;
    const wait = Math.max(0, Math.min(debounceMs, this.#firstAt + maxWaitMs - now));
    this.#timer = setTimeout(() => this.#flush(), wait);
  }

  #flush() {
    this.#timer = null;
    const paths = [...this.#pending];
    this.#pending.clear();
    if (!this.#closed && paths.length > 0) this.#options.onChanges(paths);
  }
}
