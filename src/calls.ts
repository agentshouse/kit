import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { House } from './api.ts';
import { kitHome } from './home.ts';

export type Result =
  | { provider_session_id: string }
  | { refused: string; resume_refused?: true }
  | { exit_code: number }
  | { exit_code: number; output: string; cut: boolean }
  | { timed_out: true; output: string; cut: boolean }
  | Record<string, never>;

export interface KitMethods {
  readonly open: { readonly params: Record<never, never>; readonly result: Result };
  readonly kill: { readonly params: Record<never, never>; readonly result: Result };
  readonly message: {
    readonly params: { message_id: string; text: string; first: boolean };
    readonly result: Result;
  };
  readonly interrupt: { readonly params: { turn_id: string }; readonly result: Result };
  readonly answer: {
    readonly params: { interaction_id: string; response: unknown; request: unknown };
    readonly result: Result;
  };
  readonly option: {
    readonly params: { option: string; value: string | boolean };
    readonly result: Result;
  };
  readonly sign_in: {
    readonly params: { cli: string; ends_in: number };
    readonly result: Result;
  };
  readonly update: {
    readonly params: { bootstrap: string; sha256: string; update_clis?: boolean };
    readonly result: Result;
  };
  readonly run_wizard: { readonly params: { script: string }; readonly result: Result };
  readonly run_function: {
    readonly params: { script: string; input: unknown; terminal: boolean; time_cap: number; output_cap: number };
    readonly result: Result;
  };
}

type KitMethod = keyof KitMethods;

type EnvironmentMethod = 'sign_in' | 'update' | 'run_wizard' | 'run_function';

interface ConversationHeader {
  input_id: string;
  conversation_id: string;
  agent_id: string;
  provider_session_id: string | null;
}

interface EnvironmentHeader {
  input_id: string;
}

export type Call<Method extends KitMethod = KitMethod> = {
  [Named in Method]: (Named extends EnvironmentMethod ? EnvironmentHeader : ConversationHeader) & {
    kind: Named;
  } & KitMethods[Named]['params'];
}[Method];

export interface Carried {
  result: Result;
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
  private readonly results: Map<string, Result>;
  private readonly returned = new Set<string>();
  private readonly released = new Set<string>();
  private open = 0;

  constructor(house: House, changed: () => void) {
    this.house = house;
    this.changed = changed;
    this.results = new Map(
      existsSync(this.path) ? Object.entries(JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Result>) : [],
    );
  }

  keepResult(callId: string, result: Result): void {
    if (this.returned.has(callId)) return;
    this.results.set(callId, result);
    this.save();
  }

  idle(): boolean {
    return this.open === 0;
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
    this.changed();
    return carried
      .then(async ({ result, returned, release }) => {
        try {
          await this.house.deliver(`/kit/inputs/${callId}/ack`, result);
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
        this.changed();
      });
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.results)), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
