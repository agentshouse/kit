import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './clis.ts';
import { kitHome, workspaceRoot } from './home.ts';
import type { Ack, Inputs } from './inputs.ts';
import { service, throughSudo } from './placement.ts';

export interface Update {
  input_id: string;
  bootstrap: string;
  sha256: string;
  update_clis?: boolean;
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

function manager(): string[] {
  return service() === 'user' ? ['--user'] : [];
}

function elevated(): string[] {
  return throughSudo() ? ['sudo', '-n'] : [];
}

function account(): string[] {
  return throughSudo() ? [`--uid=${process.getuid!()}`, `--gid=${process.getgid!()}`] : [];
}

function placement(): string[] {
  return service() === 'user' ? ['--workspace', workspaceRoot()] : ['--linux'];
}

function record(): string {
  return `outcome=$1; shift; bash "$0" "$@"; printf %s "$?" > "$outcome"; ${[...elevated(), 'systemctl', ...manager(), 'start', 'house-kit.service'].join(' ')}`;
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

async function forget(inputId: string): Promise<void> {
  if ((await pendingInput()) !== inputId) return;
  await rm(pending(), { force: true });
  await rm(outcome(), { force: true });
}

async function finished(inputId: string): Promise<Ack> {
  for (;;) {
    const ack = await recorded();
    if (ack !== null) return ack;
    // systemctl answers at once, so ten seconds only bounds a stuck service manager.
    if ((await run('systemctl', [...manager(), 'is-active', '--quiet', unit(inputId)], 10_000)).status !== 0) {
      return (await recorded()) ?? { refused: 'the Kit bootstrap did not finish' };
    }
    // The bootstrap runs for minutes, so checking each second sees its outcome within a second at little cost.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function rerun(script: string, inputId: string, flags: string[]): Promise<Ack | null> {
  return new Promise((resolve) => {
    const [command, ...args] = [
      ...elevated(),
      'systemd-run',
      ...manager(),
      ...account(),
      '--wait',
      '--collect',
      '--quiet',
      `--unit=${unit(inputId)}`,
      `--setenv=HOME=${homedir()}`,
      `--setenv=HOUSE_KIT_HOME=${kitHome()}`,
      '/bin/sh',
      '-c',
      record(),
      script,
      outcome(),
      ...placement(),
      ...flags,
    ];
    const child = spawn(command!, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', () => resolve({ refused: 'no service manager runs this Kit' }));
    child.on('close', () => resolve(null));
  });
}

export class Updates {
  private readonly inputs: Inputs;
  private queue: Promise<void> = Promise.resolve();

  constructor(inputs: Inputs) {
    this.inputs = inputs;
  }

  async resumed(): Promise<void> {
    const inputId = await pendingInput();
    if (inputId === null) return;
    await this.enqueue(inputId, () => finished(inputId));
  }

  start(input: Update): void {
    void this.enqueue(input.input_id, () => this.carry(input));
  }

  private enqueue(inputId: string, work: () => Promise<Ack>): Promise<void> {
    this.queue = this.queue.then(() =>
      this.inputs.carry(inputId, async () => ({ ack: await work(), acknowledged: () => forget(inputId) })),
    );
    return this.queue;
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
}
