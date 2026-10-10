import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree } from './acp.ts';
import type { Agents } from './agents.ts';
import type { House } from './api.ts';
import { CLIS, withoutProxy } from './clis.ts';
import { holdSecretInput, type Step } from './secret-input.ts';

export interface SignIn {
  input_id: string;
  cli: string;
  ends_in: number;
}

const ESCAPE = /\u001b\[[\d;]*m/g;
const LINK = /https:\/\/\S+/;
const CODE = /^[A-Z0-9]+-[A-Z0-9]+$/;

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

function endOf(signal: AbortSignal): Promise<true> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(true), { once: true }));
}

export class SignIns {
  private readonly house: House;
  private readonly agents: Agents;
  private readonly changed: () => void;
  private readonly running = new Set<string>();

  constructor(house: House, agents: Agents, changed: () => void) {
    this.house = house;
    this.agents = agents;
    this.changed = changed;
  }

  idle(): boolean {
    return this.running.size === 0;
  }

  start(input: SignIn): void {
    if (this.running.has(input.input_id)) return;
    this.running.add(input.input_id);
    this.changed();
    this.signIn(input)
      .catch(logged)
      .finally(() => {
        this.running.delete(input.input_id);
        this.changed();
      });
  }

  private async signIn(input: SignIn): Promise<void> {
    const ending = new AbortController();
    // House stops waiting for a sign-in ten minutes after it wrote it and sends the seconds left, so its install and login end with the page.
    const timer = setTimeout(() => ending.abort(), input.ends_in * 1000);
    const ended = await Promise.race([this.signedIn(input, ending.signal), endOf(ending.signal)]);
    clearTimeout(timer);
    if (ended) process.stderr.write(`kit: the ${input.cli} sign-in reached the end House set for it\n`);
    await this.house.deliver(`/kit/inputs/${input.input_id}/ack`, {});
    if (!ended) await this.agents.reread(input.cli);
  }

  private async signedIn(input: SignIn, signal: AbortSignal): Promise<false> {
    await this.login(input, signal);
    if (!signal.aborted) await this.agents.recheck(input.cli, signal);
    return false;
  }

  private async login(input: SignIn, signal: AbortSignal): Promise<void> {
    let cli: string;
    try {
      cli = await this.agents.located(input.cli, signal);
    } catch (error) {
      if (!signal.aborted) process.stderr.write(`kit: the ${input.cli} sign-in failed: ${causeOf(error)}\n`);
      return;
    }
    if (signal.aborted) return;
    const login = CLIS[input.cli]!.login;
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
      void holdSecretInput(this.house, input.input_id, steps, running).then((content) => {
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
    if (failed !== null && !signal.aborted) process.stderr.write(`kit: the ${input.cli} sign-in failed: ${failed}\n`);
  }
}
