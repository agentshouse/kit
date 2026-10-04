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

async function sshHostKey(): Promise<string | null> {
  const listed = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', '/etc/ssh/ssh_host_ed25519_key.pub'], 10_000);
  return listed.status === 0 ? (/^\d+ (SHA256:\S+)/.exec(listed.output)?.[1] ?? null) : null;
}

async function operatingSystem(): Promise<string> {
  const release = await readFile('/etc/os-release', 'utf8');
  return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)?.[1] ?? release;
}

export class Agents {
  desired: Desired = { agents: [], routes: [] };
  private readonly house: House;
  private reading: Promise<unknown> = Promise.resolve();
  private installing: Promise<void> = Promise.resolve();
  private releases = new Map<string, string | null>();
  private reporting: Promise<void> | null = null;
  private again = false;

  constructor(house: House) {
    this.house = house;
  }

  read(): Promise<void> {
    return this.reading.then(
      () => undefined,
      () => undefined,
    );
  }

  installed(): Promise<void> {
    return this.installing.catch(() => undefined);
  }

  route(agentId: string): Route | undefined {
    return this.desired.routes.find((route) => route.agent_id === agentId);
  }

  refresh(): Promise<void> {
    const reading = this.read().then(async () => {
      this.desired = await this.house.deliver<Desired>('/kit/agents/desired', {});
      return this.desired;
    });
    this.reading = reading;
    const installing = this.installed()
      .then(() => reading)
      .then(({ agents }) => this.install(agents));
    this.installing = installing;
    if (this.reporting === null) this.reporting = this.reports();
    else this.again = true;
    return Promise.all([installing, this.reporting]).then(() => undefined);
  }

  async report(): Promise<void> {
    const agents: Reported[] = [];
    for (const [kind, release] of this.releases) {
      agents.push({ kind, release, signed_in: release !== null && (await signedIn(kind)) });
    }
    const hostKey = await sshHostKey();
    await this.house.deliver('/kit/agents/report', {
      os: await operatingSystem(),
      kit_version: KIT_VERSION,
      agents,
      ...(hostKey === null ? {} : { ssh_host_key: hostKey }),
    });
  }

  private async install(kinds: string[]): Promise<void> {
    const releases = new Map<string, string | null>();
    for (const kind of kinds) releases.set(kind, await install(kind));
    this.releases = releases;
  }

  private async reports(): Promise<void> {
    try {
      do {
        this.again = false;
        await this.installing;
        await this.report();
      } while (this.again);
    } finally {
      this.reporting = null;
    }
  }
}
