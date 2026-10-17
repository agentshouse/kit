import type { House } from './api.ts';

export type Ack = { provider_session_id: string } | { refused: string } | Record<string, never>;

export interface Carried {
  ack: Ack;
  acknowledged?(): Promise<void>;
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

export class Inputs {
  private readonly house: House;
  private readonly changed: () => void;
  private readonly carried = new Map<string, Promise<Carried>>();
  private open = 0;

  constructor(house: House, changed: () => void) {
    this.house = house;
    this.changed = changed;
  }

  idle(): boolean {
    return this.open === 0;
  }

  carry(inputId: string, work: () => Promise<Carried>): Promise<void> {
    const known = this.carried.get(inputId);
    const carried = known ?? work();
    if (known === undefined) {
      this.carried.set(inputId, carried);
      carried.catch(() => this.carried.delete(inputId));
    }
    this.open++;
    this.changed();
    return carried
      .then(async ({ ack, acknowledged }) => {
        await this.house.deliver(`/kit/inputs/${inputId}/ack`, ack);
        if (known === undefined) await acknowledged?.();
      })
      .catch(logged)
      .finally(() => {
        this.open--;
        this.changed();
      });
  }
}
