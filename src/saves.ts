export interface SaveClock {
  now(): number;
  later(delay: number, callback: () => void): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: SaveClock = {
  now: () => Date.now(),
  later: (delay, callback) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
};

// A save goes 3 seconds after the last change, since an agent's change of several files lands within a few seconds and goes as one batch.
export const SAVE_QUIET_MS = 3_000;

// A save goes at the latest 30 seconds after the first change no save has sent while changes go on, the User's bound for a person to see work that goes on (User 2026-11-25).
export const SAVE_LATEST_MS = 30_000;

export class SaveTimer {
  private first: number | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private named: ReturnType<typeof setTimeout> | null = null;
  private readonly due: () => void;
  private readonly clock: SaveClock;

  constructor(due: () => void, clock: SaveClock = SYSTEM_CLOCK) {
    this.due = due;
    this.clock = clock;
  }

  changed(): void {
    const now = this.clock.now();
    this.first ??= now;
    this.stopQuiet();
    this.quiet = this.clock.later(Math.min(SAVE_QUIET_MS, this.first + SAVE_LATEST_MS - now), () => {
      this.quiet = null;
      this.due();
    });
  }

  taken(): void {
    this.first = null;
    this.stopQuiet();
  }

  admitted(at: number): void {
    this.stopNamed();
    // A save House refused until a time it named goes again at that time, when House admits writes again.
    this.named = this.clock.later(Math.max(0, at - this.clock.now()), () => {
      this.named = null;
      this.due();
    });
  }

  stop(): void {
    this.taken();
    this.stopNamed();
  }

  private stopQuiet(): void {
    if (this.quiet === null) return;
    this.clock.clear(this.quiet);
    this.quiet = null;
  }

  private stopNamed(): void {
    if (this.named === null) return;
    this.clock.clear(this.named);
    this.named = null;
  }
}
