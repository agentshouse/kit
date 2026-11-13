import type { KitCallResult } from '@agentshouse/kit-wire';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { House } from './api.ts';
import { kitHome } from './home.ts';

export interface Carried {
  result: KitCallResult;
  returned?(): Promise<void>;
  release?: boolean;
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

export class Calls {
  private readonly house: House;
  private readonly changed: () => void;
  private readonly carried = new Map<string, Promise<Carried>>();
  private readonly path = join(kitHome(), 'call-results.json');
  private readonly results: Map<string, KitCallResult>;
  private readonly returned = new Set<string>();
  private readonly released = new Set<string>();
  private readonly carrying = new Map<string, number>();
  private open = 0;

  constructor(house: House, changed: () => void) {
    this.house = house;
    this.changed = changed;
    this.results = new Map(
      existsSync(this.path) ? Object.entries(JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, KitCallResult>) : [],
    );
  }

  keepResult(callId: string, result: KitCallResult): void {
    if (this.returned.has(callId)) return;
    this.results.set(callId, result);
    this.save();
  }

  idle(): boolean {
    return this.open === 0;
  }

  busy(except?: string): boolean {
    return [...this.carrying.keys()].some((callId) => callId !== except);
  }

  carry(callId: string, work: () => Promise<Carried>): Promise<void> {
    if (this.released.has(callId)) return Promise.resolve();
    const known = this.carried.get(callId);
    const result = this.results.get(callId);
    const carried = known ?? (result === undefined ? work() : Promise.resolve<Carried>({ result }));
    if (known === undefined) {
      this.carried.set(callId, carried);
      carried.catch(() => this.carried.delete(callId));
    }
    this.open++;
    this.carrying.set(callId, (this.carrying.get(callId) ?? 0) + 1);
    this.changed();
    return carried
      .then(async ({ result, returned, release }) => {
        try {
          await this.house.deliver('kit-calls/results/return', { call: callId, ...result });
        } finally {
          this.returned.add(callId);
          if (this.results.delete(callId)) this.save();
        }
        if (known !== undefined) return;
        if (release) {
          this.carried.delete(callId);
          this.released.add(callId);
        }
        await returned?.();
      })
      .catch(logged)
      .finally(() => {
        this.open--;
        const left = this.carrying.get(callId)! - 1;
        if (left === 0) this.carrying.delete(callId);
        else this.carrying.set(callId, left);
        this.changed();
      });
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.results)), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
