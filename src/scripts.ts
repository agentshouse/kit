import { spawn as spawnPiped } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { IPty } from '@lydell/node-pty';
import type { Call, Calls, Carried, Result } from './calls.ts';
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
  output: KeptOutput | null;
  process: { pid: number } | null;
  pipes: Readable[];
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

function struck(line: string, typed: string[]): boolean {
  return typed.some((typedLine) => line.includes(typedLine));
}

class KeptOutput {
  private readonly cap: number;
  private typedText = '';
  private text = '';
  private bytes = 0;
  private line = '';
  private lineBytes = 0;
  private dropping = false;
  private cut = false;

  constructor(cap: number) {
    this.cap = cap;
  }

  typed(data: string): void {
    this.typedText += data;
  }

  add(data: string): void {
    const pieces = data.split('\n');
    const rest = pieces.pop()!;
    for (const piece of pieces) this.ended(piece);
    this.extend(rest);
  }

  kept(): { output: string; cut: boolean } {
    const typed = this.typedLines(true);
    this.text = [...this.text.split(/(?<=\n)/), this.line].filter((line) => line !== '' && !struck(line, typed)).join('');
    this.bytes = Buffer.byteLength(this.text);
    this.trim();
    return { output: this.text, cut: this.cut };
  }

  private typedLines(all: boolean): string[] {
    const lines = this.typedText.split(/\r\n|\r|\n/);
    if (!all) lines.pop();
    return lines.filter((line) => line !== '');
  }

  private ended(piece: string): void {
    const line = `${this.line}${piece}\n`;
    const dropped = this.dropping;
    this.line = '';
    this.lineBytes = 0;
    this.dropping = false;
    if (dropped || struck(line, this.typedLines(false))) return;
    this.text += line;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > 2 * this.cap) this.trim();
  }

  private extend(piece: string): void {
    if (this.dropping) return;
    this.line += piece;
    this.lineBytes += Buffer.byteLength(piece);
    if (this.lineBytes <= this.cap) return;
    this.text = '';
    this.bytes = 0;
    this.line = '';
    this.lineBytes = 0;
    this.dropping = true;
    this.cut = true;
  }

  private trim(): void {
    if (this.bytes <= this.cap) return;
    const bytes = Buffer.from(this.text);
    const start = bytes.indexOf(NEWLINE, bytes.length - this.cap - 1) + 1;
    this.text = bytes.subarray(start).toString('utf8');
    this.bytes = bytes.length - start;
    this.cut = true;
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

  private async run(id: string, plan: Plan): Promise<Carried> {
    const size = plan.terminal === 'page' ? null : FIRST_SIZE;
    const output = plan.function === null ? null : new KeptOutput(plan.function.outputCap);
    const run: Run = { plan, input: null, output, process: null, pipes: [], terminal: null, size, typed: [], ended: null, sized: Promise.withResolvers() };
    if (size !== null) run.sized.resolve();
    this.runs.set(id, run);
    try {
      return { result: await this.ran(id, run), release: plan.function !== null };
    } finally {
      this.runs.delete(id);
      if (run.input !== null) await rm(run.input, { force: true });
    }
  }

  private async ran(id: string, run: Run): Promise<Result> {
    const { plan, output } = run;
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
        ({ exited } = await this.piped(plan.script, shell, environment, run));
      } else {
        const terminal = spawn(shell, ['-c', plan.script], { name: TERMINAL, ...run.size!, cwd: process.cwd(), env: environment });
        run.process = terminal;
        run.terminal = terminal;
        terminal.onData((data) => {
          this.send({ type: 'wizard_output', wizard: id, data });
          output?.add(data);
        });
        for (const data of run.typed.splice(0)) terminal.write(data);
        exited = new Promise((resolve) => terminal.onExit(({ exitCode, signal }) => resolve(signal ? SIGNALLED + signal : exitCode)));
      }
    } catch (error) {
      return failed(plan, causeOf(error));
    }
    let timedOut = false;
    // House sends a function run's time cap in seconds, and a run still going at its cap ends with its process group and the output pipes it holds.
    const capped = plan.function === null ? undefined : setTimeout(() => {
      timedOut = true;
      this.stop(run);
    }, plan.function.timeCap * 1000);
    const code = await exited;
    clearTimeout(capped);
    if (run.ended !== null) return run.ended;
    if (output === null) return { exit_code: code };
    const kept = output.kept();
    return timedOut ? { timed_out: true, ...kept } : { exit_code: code, ...kept };
  }

  private async piped(script: string, shell: string, environment: NodeJS.ProcessEnv, run: Run): Promise<{ exited: Promise<number> }> {
    const child = spawnPiped(shell, ['-c', script], { cwd: process.cwd(), env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number>((resolve) =>
      child.once('close', (code, signal) => resolve(signal === null ? code! : SIGNALLED + constants.signals[signal])),
    );
    await once(child, 'spawn');
    run.process = { pid: child.pid! };
    run.pipes = [child.stdout, child.stderr];
    for (const pipe of run.pipes) {
      pipe.setEncoding('utf8');
      pipe.on('data', (data: string) => run.output!.add(data));
    }
    if (run.ended !== null) this.stop(run);
    return { exited };
  }

  private typed(run: Run, data: string): void {
    run.output?.typed(data);
    if (run.terminal === null) run.typed.push(data);
    else run.terminal.write(data);
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
    this.stop(run);
  }

  private stop(run: Run): void {
    if (run.process !== null) killTree(run.process);
    for (const pipe of run.pipes) pipe.destroy();
  }
}
