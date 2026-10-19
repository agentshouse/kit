import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './clis.ts';
import { kitHome, workspaceRoot } from './home.ts';
import type { Call, Calls, Result } from './calls.ts';
import { service, throughSudo } from './placement.ts';

export type UpdateCall = Call<'update'>;

function directory(): string {
  return join(kitHome(), 'update');
}

function pending(): string {
  return join(directory(), 'pending.json');
}

function outcome(): string {
  return join(directory(), 'outcome');
}

function unit(callId: string): string {
  return `house-kit-update-${callId}`;
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

async function pendingCall(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(pending(), 'utf8')) as { input_id: string }).input_id;
  } catch {
    return null;
  }
}

async function recorded(): Promise<Result | null> {
  const status = await readFile(outcome(), 'utf8').catch(() => null);
  if (status === null) return null;
  return status.trim() === '0' ? {} : { refused: `the Kit bootstrap exited with ${status.trim()}` };
}

async function forget(callId: string): Promise<void> {
  if ((await pendingCall()) !== callId) return;
  await rm(pending(), { force: true });
  await rm(outcome(), { force: true });
}

async function finished(callId: string): Promise<Result> {
  for (;;) {
    const result = await recorded();
    if (result !== null) return result;
    // systemctl answers at once, so ten seconds only bounds a stuck service manager.
    if ((await run('systemctl', [...manager(), 'is-active', '--quiet', unit(callId)], 10_000)).status !== 0) {
      return (await recorded()) ?? { refused: 'the Kit bootstrap did not finish' };
    }
    // The bootstrap runs for minutes, so checking each second sees its outcome within a second at little cost.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function rerun(script: string, callId: string, flags: string[]): Promise<Result | null> {
  return new Promise((resolve) => {
    const [command, ...args] = [
      ...elevated(),
      'systemd-run',
      ...manager(),
      ...account(),
      '--wait',
      '--collect',
      '--quiet',
      `--unit=${unit(callId)}`,
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
    child.on('error', () => resolve({ refused: 'no service manager runs this Kit process' }));
    child.on('close', () => resolve(null));
  });
}

export class KitUpdate {
  private readonly calls: Calls;
  private queue: Promise<void> = Promise.resolve();

  constructor(calls: Calls) {
    this.calls = calls;
  }

  async resumed(): Promise<void> {
    const callId = await pendingCall();
    if (callId === null) return;
    await this.enqueue(callId, () => finished(callId));
  }

  start(call: UpdateCall): void {
    void this.enqueue(call.input_id, () => this.carry(call));
  }

  private enqueue(callId: string, work: () => Promise<Result>): Promise<void> {
    const before = this.queue;
    const carried = this.calls.carry(callId, async () => {
      await before;
      return { result: await work(), returned: () => forget(callId) };
    });
    this.queue = before.then(() => carried);
    return carried;
  }

  private async carry(call: UpdateCall): Promise<Result> {
    if ((await pendingCall()) === call.input_id) return finished(call.input_id);
    const answer = await fetch(call.bootstrap);
    if (!answer.ok) return { refused: `the Kit bootstrap could not be downloaded: ${answer.status}` };
    const script = Buffer.from(await answer.arrayBuffer());
    if (createHash('sha256').update(script).digest('hex') !== call.sha256) {
      return { refused: 'the Kit bootstrap does not match its sha256' };
    }
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const path = join(directory(), 'connect-linux.sh');
    await writeFile(path, script, { mode: 0o700 });
    await rm(outcome(), { force: true });
    await writeFile(pending(), `${JSON.stringify({ input_id: call.input_id })}\n`, { mode: 0o600 });
    return (await rerun(path, call.input_id, call.update_clis ? ['--update-clis'] : [])) ?? (await recorded()) ?? {
      refused: 'the Kit bootstrap did not finish',
    };
  }
}
