import type { IPty } from '@lydell/node-pty';
import type { Call, Calls, Result } from './calls.ts';
import { loginPath, onLoginPath } from './clis.ts';
import type { Notification } from './connection.ts';
import { childEnvironment } from './relay.ts';
import { killTree } from './scope.ts';

export type WizardCall = Call<'run_wizard'>;

interface Size {
  cols: number;
  rows: number;
}

interface Run {
  terminal: IPty | null;
  size: Size | null;
  typed: string[];
  ended: Result | null;
  sized: PromiseWithResolvers<void>;
}

const TERMINAL = 'xterm-256color';
const SIGNALLED = 128;
const NO_BASH = "bash is not on the login shell's PATH";
const LOST: Result = { refused: 'the Kit lost its connection to House' };

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(cause: string): Result {
  process.stderr.write(`kit: a Web Wizard could not start: ${cause}\n`);
  return { refused: `the script could not start: ${cause}` };
}

export class WebWizards {
  private readonly calls: Calls;
  private readonly send: (notification: Notification) => boolean;
  private readonly runs = new Map<string, Run>();

  constructor(calls: Calls, send: (notification: Notification) => boolean) {
    this.calls = calls;
    this.send = send;
  }

  start(call: WizardCall): void {
    void this.calls.carry(call.input_id, () => this.run(call));
  }

  notified(notification: Notification): void {
    const run = this.runs.get(String(notification.wizard));
    if (run === undefined) return;
    if (notification.type === 'wizard_input') this.typed(run, String(notification.data));
    if (notification.type === 'wizard_size') this.resized(run, { cols: Number(notification.cols), rows: Number(notification.rows) });
    if (notification.type === 'wizard_end') this.end(run, {});
  }

  disconnected(): void {
    for (const run of this.runs.values()) this.end(run, LOST);
  }

  private async run(call: WizardCall): Promise<{ result: Result }> {
    const run: Run = { terminal: null, size: null, typed: [], ended: null, sized: Promise.withResolvers() };
    this.runs.set(call.input_id, run);
    try {
      return { result: await this.ran(call.input_id, call.script, run) };
    } finally {
      this.runs.delete(call.input_id);
    }
  }

  private async ran(wizard: string, script: string, run: Run): Promise<Result> {
    let terminal: IPty;
    try {
      const { spawn } = await import('@lydell/node-pty');
      const shell = await onLoginPath('bash');
      if (shell === null) return failed(NO_BASH);
      const path = await loginPath();
      await run.sized.promise;
      if (run.ended !== null) return run.ended;
      terminal = spawn(shell, ['-c', script], {
        name: TERMINAL,
        ...run.size!,
        cwd: process.cwd(),
        env: { ...childEnvironment(), PATH: path },
      });
    } catch (error) {
      return failed(causeOf(error));
    }
    run.terminal = terminal;
    terminal.onData((data) => this.send({ type: 'wizard_output', wizard, data }));
    for (const data of run.typed.splice(0)) terminal.write(data);
    const exited = await new Promise<{ exitCode: number; signal?: number }>((resolve) => terminal.onExit(resolve));
    return run.ended ?? { exit_code: exited.signal ? SIGNALLED + exited.signal : exited.exitCode };
  }

  private typed(run: Run, data: string): void {
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
    if (run.terminal !== null) killTree(run.terminal);
  }
}
