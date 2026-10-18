import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { House } from './api.ts';
import { kitHome } from './home.ts';

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
  private readonly path = join(kitHome(), 'handed-inputs.json');
  private readonly handed: Map<string, Ack>;
  private open = 0;

  constructor(house: House, changed: () => void) {
    this.house = house;
    this.changed = changed;
    this.handed = new Map(
      existsSync(this.path) ? Object.entries(JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Ack>) : [],
    );
  }

  hands(inputId: string, ack: Ack): void {
    this.handed.set(inputId, ack);
    this.save();
  }

  idle(): boolean {
    return this.open === 0;
  }

  carry(inputId: string, work: () => Promise<Carried>): Promise<void> {
    const known = this.carried.get(inputId);
    const handed = this.handed.get(inputId);
    const carried = known ?? (handed === undefined ? work() : Promise.resolve<Carried>({ ack: handed }));
    if (known === undefined) {
      this.carried.set(inputId, carried);
      carried.catch(() => this.carried.delete(inputId));
    }
    this.open++;
    this.changed();
    return carried
      .then(async ({ ack, acknowledged }) => {
        try {
          await this.house.deliver(`/kit/inputs/${inputId}/ack`, ack);
        } finally {
          if (this.handed.delete(inputId)) this.save();
        }
        if (known === undefined) await acknowledged?.();
      })
      .catch(logged)
      .finally(() => {
        this.open--;
        this.changed();
      });
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.handed)), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
