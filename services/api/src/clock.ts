/** Injectable time source: tests fast-forward instead of sleeping. */
export interface Clock {
  now(): Date;
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

/** Manual clock for tests and for decay simulation in local dev. */
export function createManualClock(start: Date | string = new Date()): Clock & { advance(ms: number): void; set(d: Date): void } {
  let current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    isoNow: () => current.toISOString(),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(d: Date) {
      current = new Date(d.getTime());
    },
  };
}
