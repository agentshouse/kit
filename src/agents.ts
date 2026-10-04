import { client, type SessionConfigOption, type SessionConfigSelectOptions } from '@agentclientprotocol/sdk';
import { readFile } from 'node:fs/promises';
import { killTree, startAdapter, type Adapter } from './acp.ts';
import type { House } from './api.ts';
import { CLIS, KIT_VERSION, cliCommand, install, run, type Installed } from './clis.ts';
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

interface Model {
  model: string;
  efforts: string[];
}

interface Offer {
  signed_in: boolean;
  models: Model[];
}

interface Reported extends Installed, Offer {
  kind: string;
}

const SIGNED_OUT: Offer = { signed_in: false, models: [] };

function select(options: SessionConfigOption[], category: string) {
  const option = options.find((candidate) => candidate.category === category);
  return option?.type === 'select' ? option : undefined;
}

function values(options: SessionConfigSelectOptions): string[] {
  return options.flatMap((entry) => ('group' in entry ? entry.options : [entry])).map((entry) => entry.value);
}

async function models(adapter: Adapter): Promise<Model[]> {
  const agent = adapter.connection.agent;
  const opened = await agent.request('session/new', { cwd: kitHome(), mcpServers: [] });
  let options = opened.configOptions ?? [];
  const model = select(options, 'model');
  if (model === undefined) return [];
  const offered: Model[] = [];
  for (const value of values(model.options)) {
    if (select(options, 'model')?.currentValue !== value) {
      options = (
        await agent.request('session/set_config_option', { sessionId: opened.sessionId, configId: model.id, value })
      ).configOptions;
    }
    const effort = select(options, 'thought_level');
    offered.push({ model: value, efforts: effort === undefined ? [] : values(effort.options) });
  }
  return offered;
}

async function offer(kind: string): Promise<Offer> {
  const probe = CLIS[kind]!.signedIn;
  if ('command' in probe && (await run(cliCommand(kind), probe.command, 30_000)).status !== 0) return SIGNED_OUT;
  let adapter: Adapter | undefined;
  try {
    adapter = await startAdapter(kind, kitHome(), client({ name: '@agentshouse/kit' }));
    if ('initializeMeta' in probe) {
      const method = adapter.initialized._meta?.[probe.initializeMeta];
      if (typeof method !== 'string' || method.length === 0) return SIGNED_OUT;
    }
    return { signed_in: true, models: await models(adapter) };
  } catch (error) {
    process.stderr.write(`kit: ${kind} did not offer its models: ${error instanceof Error ? error.message : String(error)}\n`);
    return { signed_in: adapter !== undefined || 'command' in probe, models: [] };
  } finally {
    if (adapter !== undefined) killTree(adapter.child);
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
  private installs = new Map<string, Installed>();
  private reporting: Promise<void> | null = null;
  private again = false;
  private sending: Promise<void> = Promise.resolve();
  private sent: string | null = null;

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

  report(): Promise<void> {
    const sending = this.sending.catch(() => undefined).then(() => this.send());
    this.sending = sending;
    return sending;
  }

  private async send(): Promise<void> {
    const agents: Reported[] = [];
    for (const [kind, installed] of this.installs) {
      agents.push({ kind, ...installed, ...(installed.release === null ? SIGNED_OUT : await offer(kind)) });
    }
    const hostKey = await sshHostKey();
    const body = {
      os: await operatingSystem(),
      kit_version: KIT_VERSION,
      agents,
      ...(hostKey === null ? {} : { ssh_host_key: hostKey }),
    };
    const state = JSON.stringify(body);
    if (state === this.sent) return;
    await this.house.deliver('/kit/agents/report', body);
    this.sent = state;
  }

  private async install(kinds: string[]): Promise<void> {
    const installs = new Map<string, Installed>();
    for (const kind of kinds) installs.set(kind, await install(kind));
    this.installs = installs;
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
