import { client } from '@agentclientprotocol/sdk';
import { readFile } from 'node:fs/promises';
import { startAdapter } from './acp.ts';
import type { House } from './api.ts';
import { CLIS, KIT_VERSION, cliCommand, install, run } from './clis.ts';
import { kitHome } from './home.ts';

export interface Route {
  agent_id: string;
  kind: string;
  base_instructions: string;
  working_directory: string;
  model: string;
  effort: string | null;
}

export interface Desired {
  agents: string[];
  routes: Route[];
}

export interface Reported {
  kind: string;
  release: string | null;
  signed_in: boolean;
}

async function signedIn(kind: string): Promise<boolean> {
  const probe = CLIS[kind]!.signedIn;
  if ('command' in probe) {
    return (await run(cliCommand(kind), probe.command, 30_000)).status === 0;
  }
  try {
    const adapter = await startAdapter(kind, kitHome(), client({ name: '@agentshouse/kit' }));
    adapter.child.kill('SIGKILL');
    const method = adapter.initialized._meta?.[probe.initializeMeta];
    return typeof method === 'string' && method.length > 0;
  } catch {
    return false;
  }
}

async function operatingSystem(): Promise<string> {
  const release = await readFile('/etc/os-release', 'utf8');
  return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)?.[1] ?? release;
}

export class Agents {
  desired: Desired = { agents: [], routes: [] };
  private readonly house: House;
  private reading: Promise<void> = Promise.resolve();
  private reporting: Promise<void> | null = null;
  private again = false;

  constructor(house: House) {
    this.house = house;
  }

  read(): Promise<void> {
    return this.reading.catch(() => undefined);
  }

  settled(): Promise<void> {
    return (this.reporting ?? Promise.resolve()).catch(() => undefined);
  }

  route(agentId: string): Route | undefined {
    return this.desired.routes.find((route) => route.agent_id === agentId);
  }

  refresh(): Promise<void> {
    const reading = this.read().then(async () => {
      this.desired = await this.house.deliver<Desired>('/kit/agents/desired', {});
    });
    this.reading = reading;
    if (this.reporting === null) this.reporting = this.reports();
    else this.again = true;
    return Promise.all([reading, this.reporting]).then(() => undefined);
  }

  async report(): Promise<void> {
    const agents: Reported[] = [];
    for (const kind of this.desired.agents) {
      const release = await install(kind);
      agents.push({ kind, release, signed_in: release !== null && (await signedIn(kind)) });
    }
    await this.house.deliver('/kit/agents/report', {
      os: await operatingSystem(),
      kit_version: KIT_VERSION,
      agents,
    });
  }

  private async reports(): Promise<void> {
    try {
      do {
        this.again = false;
        await this.reading;
        await this.report();
      } while (this.again);
    } finally {
      this.reporting = null;
    }
  }
}
