export interface SilenceClock {
  later(delay: number, callback: () => void): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: SilenceClock = {
  later: (delay, callback) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
};

export class Silence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly interval: number;
  private readonly silent: () => void;
  private readonly clock: SilenceClock;

  constructor(interval: number, silent: () => void, clock: SilenceClock = SYSTEM_CLOCK) {
    this.interval = interval;
    this.silent = silent;
    this.clock = clock;
  }

  heard(): void {
    this.stop();
    this.timer = this.clock.later(this.interval, () => {
      this.timer = null;
      this.silent();
    });
  }

  stop(): void {
    if (this.timer === null) return;
    this.clock.clear(this.timer);
    this.timer = null;
  }
}
