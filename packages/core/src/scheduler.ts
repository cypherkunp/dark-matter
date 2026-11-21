import type { SchedulerStatus } from "@dark-matter/contracts";
import type { Clock } from "./clock";
import { log } from "./log";
import type { Notifier } from "./notifier";

/** How often the scheduler looks at the clock. Also how soon it notices a wake. */
const CHECK_EVERY_MS = 60_000;

/** What a daily job gets. Jobs record their own Activity entries with `client`. */
export interface DailyJobContext {
  client: "scheduled-scan";
  notifier: Notifier;
}

/**
 * One step of the daily run. Steps run in order and one failing doesn't stop
 * the rest. Every run must record at least one Activity entry as the
 * `scheduled-scan` client: that's how the scheduler knows it ran.
 */
export interface DailyJob {
  name: string;
  run(context: DailyJobContext): Promise<void>;
}

export interface SchedulerOptions {
  clock: Clock;
  notifier: Notifier;
  /** The Scheduled Scan time, local `HH:MM` (read on every check, so a change applies at once). */
  time: () => string;
  /**
   * When the daily run last started (the latest `scheduled-scan` Activity
   * entry), else when the last Scan of any kind ran, else null: before the
   * first Scan nothing runs, because the First run asks first.
   */
  lastRun: () => { at: Date; scheduled: boolean } | null;
  jobs: readonly DailyJob[];
  onChange: () => void;
}

/** The most recent `HH:MM` local slot at or before `now`. */
const slotAtOrBefore = (now: Date, time: string): Date => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return slot;
};

/**
 * The daily Scheduled Scan (ADR-0003): it runs in the core, checks the clock
 * every minute and runs the daily jobs once the day's slot has passed since
 * the last run. A slot missed while the app was closed or the computer slept
 * runs on the next check after start or wake, once however many were missed.
 */
export class Scheduler {
  readonly #options: SchedulerOptions;
  #running: Promise<void> | null = null;
  #stop: (() => void) | null = null;
  /** The slot the last run was for, so a run that recorded nothing isn't retried every minute. */
  #attempted: number | null = null;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  /** Whether a daily run is due now. */
  due(): boolean {
    const last = this.#options.lastRun();
    if (!last) return false;
    const slot = slotAtOrBefore(this.#options.clock.now(), this.#options.time());
    return last.at < slot && this.#attempted !== slot.getTime();
  }

  start(): void {
    this.#stop = this.#options.clock.every(CHECK_EVERY_MS, () => this.check());
    this.check();
  }

  /** Runs the daily jobs if they're due and not already running. */
  check(): void {
    if (this.#running || !this.due()) return;
    this.#attempted = slotAtOrBefore(this.#options.clock.now(), this.#options.time()).getTime();
    this.#running = this.#run().finally(() => {
      this.#running = null;
      this.#options.onChange();
    });
  }

  status(): SchedulerStatus {
    const time = this.#options.time();
    const last = this.#options.lastRun();
    let nextRunAt: string | null = null;
    if (last) {
      const next = slotAtOrBefore(this.#options.clock.now(), time);
      if (!this.due()) next.setDate(next.getDate() + 1);
      nextRunAt = next.toISOString();
    }
    return { time, nextRunAt, lastRunAt: last?.scheduled ? last.at.toISOString() : null };
  }

  /** Stops checking and waits for a daily run in progress. */
  async stop(): Promise<void> {
    this.#stop?.();
    await this.#running;
  }

  async #run(): Promise<void> {
    const context: DailyJobContext = { client: "scheduled-scan", notifier: this.#options.notifier };
    for (const job of this.#options.jobs) {
      try {
        await job.run(context);
      } catch (error) {
        log(`Scheduled Scan job ${job.name} failed: ${String(error)}`);
      }
    }
  }
}
