/** The core's view of time, injected so tests can control it. */
export interface Clock {
  now(): Date;
  /** Calls `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};
