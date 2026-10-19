import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Agents } from './agents.ts';
import type { House } from './api.ts';
import { CLIS, withoutProxy } from './clis.ts';
import type { Call, Calls, Carried } from './calls.ts';
import { killTree } from './scope.ts';
import { holdSecretInput, type Step } from './secret-input.ts';

export type SignInCall = Call<'sign_in'>;

const ESCAPE = /\u001b\[[\d;]*m/g;
const LINK = /https:\/\/\S+/;
const CODE = /^[A-Z0-9]+-[A-Z0-9]+$/;

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endOf(signal: AbortSignal): Promise<true> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(true), { once: true }));
}

export class SignIns {
  private readonly house: House;
  private readonly agents: Agents;
  private readonly calls: Calls;

  constructor(house: House, agents: Agents, calls: Calls) {
    this.house = house;
    this.agents = agents;
    this.calls = calls;
  }

  start(call: SignInCall): void {
    void this.calls.carry(call.input_id, () => this.signIn(call));
  }

  private async signIn(call: SignInCall): Promise<Carried> {
    const ending = new AbortController();
    // House stops waiting for a sign-in ten minutes after it wrote it and sends the seconds left, so its install and login end with the page.
    const timer = setTimeout(() => ending.abort(), call.ends_in * 1000);
    const ended = await Promise.race([this.signedIn(call, ending.signal), endOf(ending.signal)]);
    clearTimeout(timer);
    if (ended) process.stderr.write(`kit: the ${call.cli} sign-in reached the end House set for it\n`);
    return ended ? { result: {} } : { result: {}, returned: () => this.agents.reread(call.cli) };
  }

  private async signedIn(call: SignInCall, signal: AbortSignal): Promise<false> {
    await this.login(call, signal);
    if (!signal.aborted) await this.agents.recheck(call.cli, signal);
    return false;
  }

  private async login(call: SignInCall, signal: AbortSignal): Promise<void> {
    let cli: string;
    try {
      cli = await this.agents.located(call.cli, signal);
    } catch (error) {
      if (!signal.aborted) process.stderr.write(`kit: the ${call.cli} sign-in failed: ${causeOf(error)}\n`);
      return;
    }
    if (signal.aborted) return;
    const login = CLIS[call.cli]!.login;
    const child = spawn(cli, login.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: withoutProxy(),
    });
    const running = () => child.exitCode === null && child.signalCode === null;
    const stop = () => killTree(child);
    signal.addEventListener('abort', stop, { once: true });
    let link: string | undefined;
    let code: string | undefined;
    let last = '';
    let held = false;
    const read = (line: string) => {
      const plain = line.replace(ESCAPE, '').trim();
      if (plain === '') return;
      last = plain;
      if (login.code === 'collect' && plain.includes(login.rejected)) killTree(child);
      link ??= LINK.exec(plain)?.[0];
      if (CODE.test(plain)) code ??= plain;
      const step: Step | undefined =
        login.code === 'collect'
          ? { kind: 'collect', label: 'Code shown after you sign in', name: 'code' }
          : code === undefined
            ? undefined
            : { kind: 'show', label: 'One-time code', text: code };
      if (held || link === undefined || step === undefined) return;
      held = true;
      const steps: Step[] = [{ kind: 'visit', label: 'Open this link and sign in', url: link }, step];
      void holdSecretInput(this.house, call.input_id, steps, running).then((content) => {
        if (!running()) return;
        if (content === null) killTree(child);
        else child.stdin.end(`${content.code}\n`);
      });
    };
    for (const output of [child.stdout, child.stderr]) createInterface({ input: output }).on('line', read);
    const failed = await new Promise<string | null>((resolve) => {
      child.on('error', (error) => resolve(error.message));
      child.on('close', (status, killed) =>
        resolve(status === 0 ? null : `exited with ${status ?? killed}${last ? `: ${last}` : ''}`),
      );
    });
    signal.removeEventListener('abort', stop);
    if (failed !== null && !signal.aborted) process.stderr.write(`kit: the ${call.cli} sign-in failed: ${failed}\n`);
  }
}
