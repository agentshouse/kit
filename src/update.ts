import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadServed, servedRelease } from './building.ts';
import type { Call, Calls, Result } from './calls.ts';
import { KIT_RELEASE } from './clis.ts';
import { restart, updateLine } from './end.ts';
import { kitHome, readEnrolment } from './home.ts';
import { placedPrefix } from './placement.ts';
import { childEnvironment, relayOrigin } from './relay.ts';

export type UpdateCall = Call<'update'>;

const INSTALLER_BYTES = 1_000_000;

// A release's Node.js, Kit package and adapters are about a hundred megabytes, so an hour carries them at thirty kilobytes a second, and a placement still running then has hung.
const PLACEMENT_MS = 60 * 60_000;

// A refused Kit is offline until its placement succeeds, so it tries again within five minutes of its Building or this computer recovering, while a placement that fails only after its hundred-megabyte download runs at most twelve times an hour.
export const PLACEMENT_RETRY_MS = 5 * 60_000;

const REFUSED = 'kit_bootstrap_refused: ';

const OUTPUT_CHARACTERS = 4000;

function causeOf(error: unknown): string {
  if (error instanceof TypeError && error.cause instanceof Error) return `the Building did not answer: ${error.cause.message}`;
  return error instanceof Error ? error.message : String(error);
}

function placing(installer: string, house: string, prefix: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const relay = relayOrigin();
    const child = spawn('bash', [installer, '--house', house, '--place', prefix], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childEnvironment(), ...(relay === undefined ? {} : { HOUSE_KIT_RELAY: relay }) },
      detached: true,
    });
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        output = (output + chunk).slice(-OUTPUT_CHARACTERS);
      });
    }
    const ended = (failure: string | null) => {
      signal.removeEventListener('abort', stop);
      resolve(failure);
    };
    child.on('error', (error) => ended(error.message));
    child.on('close', (status) => {
      if (status === 0) return ended(null);
      if (signal.aborted) return ended(`the placement did not end within ${PLACEMENT_MS / 1000} seconds`);
      const lines = output.split('\n').filter((line) => line.trim() !== '');
      const refused = lines.findLast((line) => line.startsWith(REFUSED));
      ended(refused?.slice(REFUSED.length) ?? lines.at(-1) ?? `the placement ended with status ${status ?? 'a signal'}`);
    });
  });
}

export class KitUpdate {
  private readonly calls: Calls;
  private queue: Promise<unknown> = Promise.resolve();
  private placed: string | null = null;

  constructor(calls: Calls) {
    this.calls = calls;
  }

  take(call: UpdateCall): void {
    void this.calls.carry(call.input_id, async () => ({ result: await this.queued(() => this.update(call.release)) }));
  }

  async takeRefused(release: string): Promise<never> {
    for (;;) {
      const failure = await this.queued(async () => (this.placed === null ? this.place(release, 'served') : null));
      if (failure === null) restart(`Kit ${this.placed} is placed; its supervisor starts it`);
      process.stderr.write(`kit: ${updateLine(`Kit ${KIT_RELEASE} stays offline and tries again in ${PLACEMENT_RETRY_MS / 60_000} minutes`)}\n`);
      await new Promise((resolve) => setTimeout(resolve, PLACEMENT_RETRY_MS));
    }
  }

  placedRelease(): string | null {
    return this.placed;
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const taken = this.queue.then(work);
    this.queue = taken.catch(() => undefined);
    return taken;
  }

  private async update(release: string): Promise<Result> {
    if (release === (this.placed ?? KIT_RELEASE)) return {};
    if (this.placed !== null) return { refused: `Kit ${this.placed} is placed and starts first, once no turn is open` };
    const failure = await this.place(release, 'named');
    if (failure !== null) return { refused: failure };
    process.stderr.write(`kit: Kit ${release} is placed; it starts once no turn is open\n`);
    return {};
  }

  private async place(release: string, which: 'named' | 'served'): Promise<string | null> {
    const signal = AbortSignal.timeout(PLACEMENT_MS);
    let version = release;
    let failure: string | null;
    try {
      const prefix = placedPrefix();
      const served = await servedRelease(signal);
      if (which === 'named' && served.version !== release) throw new Error(`the Building serves Kit ${served.version}, not Kit ${release}`);
      version = served.version;
      if (version === KIT_RELEASE) throw new Error(`the Building serves Kit ${KIT_RELEASE}, which this Kit runs`);
      await mkdir(join(kitHome(), 'update'), { recursive: true, mode: 0o700 });
      const installer = join(kitHome(), 'update', served.installer);
      await downloadServed(served.installer, served.sha256, installer, signal, INSTALLER_BYTES);
      failure = await placing(installer, (await readEnrolment())!.house, prefix, signal);
    } catch (error) {
      failure = signal.aborted ? `the placement did not end within ${PLACEMENT_MS / 1000} seconds` : causeOf(error);
    }
    if (failure !== null) {
      const refused = `Kit ${version} could not be placed: ${failure}`;
      process.stderr.write(`kit: ${refused}\n`);
      return refused;
    }
    this.placed = version;
    return null;
  }
}
