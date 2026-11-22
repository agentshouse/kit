import type { LocalCopies } from './copies.ts';

// A copy whose conversation had no turn in it for a day goes: a person who comes back to a conversation within a working day keeps its copy, and one nobody comes back to stops holding the Room's files.
export const IDLE_COPY_MS = 24 * 60 * 60_000;

// A look every half hour removes an idle copy within half an hour of its day passing, and reads a copy left holding work at most twice an hour.
const IDLE_LOOK_MS = 30 * 60_000;

function logged(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

export class IdleCopies {
  private readonly copies: LocalCopies;
  private readonly runsIn: (directory: string) => boolean;
  private readonly changed: () => void;
  private looking = false;

  constructor(copies: LocalCopies, runsIn: (directory: string) => boolean, changed: () => void) {
    this.copies = copies;
    this.runsIn = runsIn;
    this.changed = changed;
  }

  idle(): boolean {
    return !this.looking;
  }

  keepRemoving(standing: () => boolean): void {
    this.look(standing);
    setInterval(() => this.look(standing), IDLE_LOOK_MS);
  }

  private look(standing: () => boolean): void {
    if (this.looking || standing()) return;
    this.looking = true;
    void this.copies
      .removedIdle(Date.now() - IDLE_COPY_MS, this.runsIn)
      .catch(logged)
      .finally(() => {
        this.looking = false;
        this.changed();
      });
  }
}
