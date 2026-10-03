import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree } from './acp.ts';
import type { Agents } from './agents.ts';
import type { House } from './api.ts';
import { CLIS, cliCommand } from './clis.ts';
import { holdSecretInput, type Step } from './secret-input.ts';

export interface SignIn {
  input_id: string;
  cli: string;
}

const ESCAPE = /\u001b\[[\d;]*m/g;
const LINK = /https:\/\/\S+/;
const CODE = /^[A-Z0-9]+-[A-Z0-9]+$/;

function logged(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
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
    this.login(input)
      .then(() => this.agents.report())
      .then(() => this.house.deliver(`/kit/inputs/${input.input_id}/ack`, {}))
      .catch(logged)
      .finally(() => {
        this.running.delete(input.input_id);
        this.changed();
      });
  }

  private async login(input: SignIn): Promise<void> {
    await this.agents.installed();
    const login = CLIS[input.cli]!.login;
    const child = spawn(cliCommand(input.cli), login.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const running = () => child.exitCode === null && child.signalCode === null;
    let link: string | undefined;
    let code: string | undefined;
    let last = '';
    let held = false;
    const read = (line: string) => {
      const plain = line.replace(ESCAPE, '').trim();
      if (plain === '') return;
      last = plain;
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
      child.on('close', (status, signal) =>
        resolve(status === 0 ? null : `exited with ${status ?? signal}${last ? `: ${last}` : ''}`),
      );
    });
    if (failed !== null) process.stderr.write(`kit: the ${input.cli} sign-in failed: ${failed}\n`);
  }
}
