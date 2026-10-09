import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { House } from './api.ts';
import { run } from './clis.ts';
import { kitHome } from './home.ts';

export interface Update {
  input_id: string;
  bootstrap: string;
  sha256: string;
  update_clis?: boolean;
}

type Ack = Record<string, never> | { refused: string };

const RECORD = 'outcome=$1; shift; bash "$0" --linux "$@"; printf %s "$?" > "$outcome"; systemctl start house-kit.service';

function logged(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

function directory(): string {
  return join(kitHome(), 'update');
}

function pending(): string {
  return join(directory(), 'pending.json');
}

function outcome(): string {
  return join(directory(), 'outcome');
}

function unit(inputId: string): string {
  return `house-kit-update-${inputId}`;
}

async function pendingInput(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(pending(), 'utf8')) as { input_id: string }).input_id;
  } catch {
    return null;
  }
}

async function recorded(): Promise<Ack | null> {
  const status = await readFile(outcome(), 'utf8').catch(() => null);
  if (status === null) return null;
  return status.trim() === '0' ? {} : { refused: `the Kit bootstrap exited with ${status.trim()}` };
}

async function finished(inputId: string): Promise<Ack> {
  for (;;) {
    const ack = await recorded();
    if (ack !== null) return ack;
    // systemctl answers at once, so ten seconds only bounds a stuck service manager.
    if ((await run('systemctl', ['is-active', '--quiet', unit(inputId)], 10_000)).status !== 0) {
      return (await recorded()) ?? { refused: 'the Kit bootstrap did not finish' };
    }
    // The bootstrap runs for minutes, so checking each second sees its outcome within a second at little cost.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function rerun(script: string, inputId: string, flags: string[]): Promise<Ack | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'systemd-run',
      [
        '--wait',
        '--collect',
        '--quiet',
        `--unit=${unit(inputId)}`,
        `--setenv=HOME=${homedir()}`,
        '/bin/sh',
        '-c',
        RECORD,
        script,
        outcome(),
        ...flags,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('error', () => resolve({ refused: 'no service manager runs this Kit' }));
    child.on('close', () => resolve(null));
  });
}

export class Updates {
  private readonly house: House;
  private readonly held = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(house: House) {
    this.house = house;
  }

  async resumed(): Promise<void> {
    const inputId = await pendingInput();
    if (inputId === null) return;
    await this.acknowledge(inputId, await finished(inputId));
  }

  start(input: Update): void {
    if (this.held.has(input.input_id)) return;
    this.held.add(input.input_id);
    this.queue = this.queue
      .then(() => this.carry(input))
      .then((ack) => this.acknowledge(input.input_id, ack))
      .catch(logged)
      .finally(() => this.held.delete(input.input_id));
  }

  private async carry(input: Update): Promise<Ack> {
    if ((await pendingInput()) === input.input_id) return finished(input.input_id);
    const answer = await fetch(input.bootstrap);
    if (!answer.ok) return { refused: `the Kit bootstrap could not be downloaded: ${answer.status}` };
    const script = Buffer.from(await answer.arrayBuffer());
    if (createHash('sha256').update(script).digest('hex') !== input.sha256) {
      return { refused: 'the Kit bootstrap does not match its sha256' };
    }
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const path = join(directory(), 'connect-linux.sh');
    await writeFile(path, script, { mode: 0o700 });
    await rm(outcome(), { force: true });
    await writeFile(pending(), `${JSON.stringify({ input_id: input.input_id })}\n`, { mode: 0o600 });
    return (await rerun(path, input.input_id, input.update_clis ? ['--update-clis'] : [])) ?? (await recorded()) ?? {
      refused: 'the Kit bootstrap did not finish',
    };
  }

  private async acknowledge(inputId: string, ack: Ack): Promise<void> {
    await this.house.deliver(`/kit/inputs/${inputId}/ack`, ack);
    if ((await pendingInput()) !== inputId) return;
    await rm(pending(), { force: true });
    await rm(outcome(), { force: true });
  }
}
