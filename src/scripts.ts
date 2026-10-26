import { spawn as spawnPiped } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';
import type { IPty } from '@lydell/node-pty';
import type { Call, Calls, Result } from './calls.ts';
import { loginPath, onLoginPath } from './clis.ts';
import type { Notification } from './connection.ts';
import { kitHome } from './home.ts';
import { childEnvironment } from './relay.ts';
import { killTree } from './scope.ts';

export type ScriptCall = Call<'run_wizard' | 'run_function'>;

interface Size {
  cols: number;
  rows: number;
}

interface FunctionRun {
  input: unknown;
  timeCap: number;
  outputCap: number;
}

interface Plan {
  named: string;
  script: string;
  terminal: 'page' | 'at once' | null;
  function: FunctionRun | null;
}

interface Run {
  plan: Plan;
  input: string | null;
  process: { pid: number } | null;
  terminal: IPty | null;
  size: Size | null;
  typed: string[];
  ended: Result | null;
  sized: PromiseWithResolvers<void>;
}

const TERMINAL = 'xterm-256color';
const FIRST_SIZE: Size = { cols: 80, rows: 24 };
const SIGNALLED = 128;
const NEWLINE = 0x0a;
const NO_BASH = "bash is not on the login shell's PATH";
const LOST: Result = { refused: 'the Kit lost its connection to House' };

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(plan: Plan, cause: string): Result {
  process.stderr.write(`kit: ${plan.named} could not start: ${cause}\n`);
  return { refused: `the script could not start: ${cause}` };
}

function planned(call: ScriptCall): Plan {
  if (call.kind === 'run_wizard') return { named: 'a Web Wizard', script: call.script, terminal: 'page', function: null };
  return {
    named: 'an Environment function',
    script: call.script,
    terminal: call.terminal ? 'at once' : null,
    function: { input: call.input, timeCap: call.time_cap, outputCap: call.output_cap },
  };
}

function inputs(): string {
  return join(kitHome(), 'inputs');
}

async function inputFile(value: unknown): Promise<string> {
  await mkdir(inputs(), { recursive: true, mode: 0o700 });
  const path = join(inputs(), `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  return path;
}

export function removeInputs(): void {
  rmSync(inputs(), { recursive: true, force: true });
}

class KeptOutput {
  private readonly cap: number;
  private text = '';
  private bytes = 0;
  private dropping = false;
  private cut = false;

  constructor(cap: number) {
    this.cap = cap;
  }

  add(data: string): void {
    if (this.dropping) {
      const next = data.indexOf('\n');
      if (next === -1) return;
      data = data.slice(next + 1);
      this.dropping = false;
    }
    this.text += data;
    this.bytes += Buffer.byteLength(data);
    if (this.bytes > 2 * this.cap) this.trim();
  }

  kept(typed: string[]): { output: string; cut: boolean } {
    const lines = typed
      .join('')
      .split(/\r\n|\r|\n/)
      .filter((line) => line !== '');
    this.text = this.text
      .split(/(?<=\n)/)
      .filter((line) => !lines.some((typedLine) => line.includes(typedLine)))
      .join('');
    this.bytes = Buffer.byteLength(this.text);
    if (this.bytes > this.cap) this.trim();
    return { output: this.text, cut: this.cut };
  }

  private trim(): void {
    const bytes = Buffer.from(this.text);
    const lineEnd = bytes.indexOf(NEWLINE, bytes.length - this.cap - 1);
    this.cut = true;
    this.dropping = lineEnd === -1;
    this.text = lineEnd === -1 ? '' : bytes.subarray(lineEnd + 1).toString('utf8');
    this.bytes = Buffer.byteLength(this.text);
  }
}

export class Scripts {
  private readonly calls: Calls;
  private readonly send: (notification: Notification) => boolean;
  private readonly runs = new Map<string, Run>();

  constructor(calls: Calls, send: (notification: Notification) => boolean) {
    this.calls = calls;
    this.send = send;
  }

  start(call: ScriptCall): void {
    void this.calls.carry(call.input_id, () => this.run(call.input_id, planned(call)));
  }

  notified(notification: Notification): void {
    const run = this.runs.get(String(notification.wizard));
    if (run === undefined) return;
    if (notification.type === 'wizard_input') this.typed(run, String(notification.data));
    if (notification.type === 'wizard_size') this.resized(run, { cols: Number(notification.cols), rows: Number(notification.rows) });
    if (notification.type === 'wizard_end' && run.plan.terminal === 'page') this.end(run, {});
  }

  disconnected(): void {
    for (const run of this.runs.values()) this.end(run, LOST);
  }

  private async run(id: string, plan: Plan): Promise<{ result: Result }> {
    const size = plan.terminal === 'page' ? null : FIRST_SIZE;
    const run: Run = { plan, input: null, process: null, terminal: null, size, typed: [], ended: null, sized: Promise.withResolvers() };
    if (size !== null) run.sized.resolve();
    this.runs.set(id, run);
    try {
      return { result: await this.ran(id, run) };
    } finally {
      this.runs.delete(id);
      if (run.input !== null) await rm(run.input, { force: true });
    }
  }

  private async ran(id: string, run: Run): Promise<Result> {
    const { plan } = run;
    const output = plan.function === null ? null : new KeptOutput(plan.function.outputCap);
    let exited: Promise<number>;
    try {
      const { spawn } = await import('@lydell/node-pty');
      const shell = await onLoginPath('bash');
      if (shell === null) return failed(plan, NO_BASH);
      const path = await loginPath();
      await run.sized.promise;
      if (plan.function !== null) run.input = await inputFile(plan.function.input);
      if (run.ended !== null) return run.ended;
      const environment = { ...childEnvironment(), PATH: path, ...(run.input === null ? {} : { HOUSE_INPUT: run.input }) };
      if (plan.terminal === null) {
        ({ exited } = await this.piped(plan.script, shell, environment, run, (data) => output!.add(data)));
      } else {
        const terminal = spawn(shell, ['-c', plan.script], { name: TERMINAL, ...run.size!, cwd: process.cwd(), env: environment });
        run.process = terminal;
        run.terminal = terminal;
        terminal.onData((data) => {
          this.send({ type: 'wizard_output', wizard: id, data });
          output?.add(data);
        });
        for (const data of run.typed) terminal.write(data);
        exited = new Promise((resolve) => terminal.onExit(({ exitCode, signal }) => resolve(signal ? SIGNALLED + signal : exitCode)));
      }
    } catch (error) {
      return failed(plan, causeOf(error));
    }
    let timedOut = false;
    // House sends a function run's time cap in seconds, and a run still going at its cap is ended with its process group.
    const capped = plan.function === null ? undefined : setTimeout(() => {
      timedOut = true;
      killTree(run.process!);
    }, plan.function.timeCap * 1000);
    const code = await exited;
    clearTimeout(capped);
    if (run.ended !== null) return run.ended;
    if (output === null) return { exit_code: code };
    const kept = output.kept(run.typed);
    return timedOut ? { timed_out: true, ...kept } : { exit_code: code, ...kept };
  }

  private async piped(script: string, shell: string, environment: NodeJS.ProcessEnv, run: Run, add: (data: string) => void): Promise<{ exited: Promise<number> }> {
    const child = spawnPiped(shell, ['-c', script], { cwd: process.cwd(), env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number>((resolve) =>
      child.once('close', (code, signal) => resolve(signal === null ? code! : SIGNALLED + constants.signals[signal])),
    );
    await once(child, 'spawn');
    run.process = { pid: child.pid! };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', add);
    }
    if (run.ended !== null) killTree(run.process);
    return { exited };
  }

  private typed(run: Run, data: string): void {
    run.typed.push(data);
    run.terminal?.write(data);
  }

  private resized(run: Run, size: Size): void {
    run.size = size;
    run.sized.resolve();
    try {
      run.terminal?.resize(size.cols, size.rows);
    } catch {}
  }

  private end(run: Run, result: Result): void {
    if (run.ended !== null) return;
    run.ended = result;
    run.sized.resolve();
    if (run.process !== null) killTree(run.process);
  }
}
