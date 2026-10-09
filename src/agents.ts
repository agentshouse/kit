import { client, type SessionConfigOption, type SessionConfigSelectOptions } from '@agentclientprotocol/sdk';
import { readFile, realpath } from 'node:fs/promises';
import { killTree, startAdapter, type Adapter } from './acp.ts';
import type { House } from './api.ts';
import { CLIS, KIT_VERSION, below, installAdapter, installCli, locate, run, versionOf } from './clis.ts';
import { agentBase, kitHome } from './home.ts';

export interface Route {
  agent_id: string;
  kind: string;
  base_instructions: string;
  working_directory: string;
  model: string;
  effort: string | null;
  mode: string | null;
}

export interface Desired {
  agents: string[];
  routes: Route[];
}

interface Model {
  model: string;
  efforts: string[];
}

interface Mode {
  mode: string;
  name: string;
}

interface Offer {
  signed_in: boolean;
  models: Model[];
  modes: Mode[];
}

interface Reading extends Offer {
  release: string | null;
  minimum?: string;
  failure: string | null;
}

const SIGNED_OUT: Offer = { signed_in: false, models: [], modes: [] };

function select(options: SessionConfigOption[], category: string) {
  const option = options.find((candidate) => candidate.category === category);
  return option?.type === 'select' ? option : undefined;
}

function choices(options: SessionConfigSelectOptions) {
  return options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
}

function values(options: SessionConfigSelectOptions): string[] {
  return choices(options).map((entry) => entry.value);
}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

async function models(kind: string, adapter: Adapter, known: Model[]): Promise<Pick<Offer, 'models' | 'modes'>> {
  const agent = adapter.connection.agent;
  const opened = await agent.request('session/new', { cwd: kitHome(), mcpServers: [] });
  let options = opened.configOptions ?? [];
  const mode = select(options, 'mode');
  const modes = mode === undefined ? [] : choices(mode.options).map(({ value, name }) => ({ mode: value, name }));
  const model = select(options, 'model');
  if (model === undefined) return { models: [], modes };
  const offered: Model[] = [];
  for (const value of values(model.options)) {
    if (select(options, 'model')?.currentValue !== value) {
      try {
        options = (
          await agent.request('session/set_config_option', { sessionId: opened.sessionId, configId: model.id, value })
        ).configOptions;
      } catch (error) {
        process.stderr.write(`kit: ${kind} refused its model ${value}: ${causeOf(error)}\n`);
        offered.push({ model: value, efforts: known.find((entry) => entry.model === value)?.efforts ?? [] });
        continue;
      }
    }
    const effort = select(options, 'thought_level');
    offered.push({ model: value, efforts: effort === undefined ? [] : values(effort.options) });
  }
  return { models: offered, modes };
}

async function signedIn(kind: string, cli: string, known: Offer): Promise<boolean> {
  const probe = CLIS[kind]!.signedIn;
  if ('command' in probe) return (await run(cli, probe.command, 30_000)).status === 0;
  return (await offer(kind, cli, known)).signed_in;
}

async function offer(kind: string, cli: string, known: Offer): Promise<Offer> {
  const probe = CLIS[kind]!.signedIn;
  if ('command' in probe && (await run(cli, probe.command, 30_000)).status !== 0) return SIGNED_OUT;
  let adapter: Adapter | undefined;
  try {
    adapter = await startAdapter(kind, cli, kitHome(), client({ name: '@agentshouse/kit' }));
    if ('initializeMeta' in probe) {
      const method = adapter.initialized._meta?.[probe.initializeMeta];
      if (typeof method !== 'string' || method.length === 0) return SIGNED_OUT;
    }
    return { signed_in: true, ...(await models(kind, adapter, known.models)) };
  } catch (error) {
    process.stderr.write(`kit: ${kind} did not offer its models: ${causeOf(error)}\n`);
    return {
      signed_in: adapter === undefined && 'initializeMeta' in probe ? known.signed_in : true,
      models: known.models,
      modes: known.modes,
    };
  } finally {
    if (adapter !== undefined) killTree(adapter.child);
  }
}

function reported(kind: string, reading: Reading) {
  return {
    kind,
    release: reading.release,
    ...(reading.minimum === undefined ? {} : { minimum: reading.minimum }),
    failure: reading.failure,
    signed_in: reading.signed_in,
    models: reading.models,
    modes: reading.modes,
    full_access: CLIS[kind]!.fullAccess,
  };
}

function tooOld(kind: string, release: string): string {
  const cli = CLIS[kind]!;
  return `${cli.bin} ${release} is older than ${cli.minimum}, the oldest this Kit runs`;
}

async function sshHostKey(): Promise<string | null> {
  const listed = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', '/etc/ssh/ssh_host_ed25519_key.pub'], 10_000);
  return listed.status === 0 ? (/^\d+ (SHA256:\S+)/.exec(listed.output)?.[1] ?? null) : null;
}

async function operatingSystem(): Promise<string> {
  if (process.platform === 'darwin') return `macOS ${(await run('sw_vers', ['-productVersion'], 10_000)).output.trim()}`;
  const release = await readFile('/etc/os-release', 'utf8');
  return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)?.[1] ?? release;
}

export class Agents {
  desired: Desired = { agents: [], routes: [] };
  private readonly house: House;
  private reading: Promise<unknown> = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();
  private installing: Promise<unknown> = Promise.resolve();
  private readonly readings = new Map<string, Reading>();
  private readonly reads = new Map<string, number>();
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

  route(agentId: string): Route | undefined {
    return this.desired.routes.find((route) => route.agent_id === agentId);
  }

  refresh(): Promise<void> {
    const reading = this.read().then(async () => {
      this.desired = await this.house.deliver<Desired>('/kit/agents/desired', {});
      return this.desired;
    });
    this.reading = reading;
    return reading.then(({ agents }) => {
      Promise.all(agents.map((kind) => this.load(kind)))
        .then(() => this.report())
        .catch(logged);
    });
  }

  cli(kind: string): Promise<string> {
    return this.queue(kind, async () => {
      const resolved = await this.resolve(kind);
      if (!('cli' in resolved)) {
        this.update(kind, resolved);
        throw new Error(resolved.failure ?? tooOld(kind, resolved.release!));
      }
      const { cli, release } = resolved;
      const known = this.readings.get(kind);
      const kept = known?.release === null || known?.minimum !== undefined ? SIGNED_OUT : (known ?? SIGNED_OUT);
      if (known?.release !== release || known.minimum !== undefined) {
        this.update(kind, { release, failure: null, signed_in: kept.signed_in, models: kept.models, modes: kept.modes });
      }
      const read = this.nextRead(kind);
      offer(kind, cli, kept)
        .then((offered) => {
          const current = this.readings.get(kind);
          if (this.reads.get(kind) === read && current?.release === release) this.update(kind, { ...current, ...offered });
        })
        .catch(logged);
      return cli;
    });
  }

  located(kind: string): Promise<string> {
    return this.queue(kind, () => this.ensure(kind));
  }

  async reread(kind: string): Promise<void> {
    await this.examine(kind, this.readings.get(kind) ?? SIGNED_OUT, offer);
    await this.report();
  }

  async recheck(kind: string): Promise<void> {
    const known = this.readings.get(kind) ?? SIGNED_OUT;
    await this.examine(kind, known, async (kind, cli) =>
      (await signedIn(kind, cli, known)) ? { ...known, signed_in: true } : SIGNED_OUT,
    );
    await this.report();
  }

  report(): Promise<void> {
    const sending = this.sending.catch(() => undefined).then(() => this.send());
    this.sending = sending;
    return sending;
  }

  private nextRead(kind: string): number {
    const read = (this.reads.get(kind) ?? 0) + 1;
    this.reads.set(kind, read);
    return read;
  }

  private update(kind: string, reading: Reading): void {
    this.readings.set(kind, reading);
    this.report().catch(logged);
  }

  private queue<T>(kind: string, work: () => Promise<T>): Promise<T> {
    const queued = (this.queues.get(kind) ?? Promise.resolve()).then(work);
    this.queues.set(
      kind,
      queued.catch(() => undefined),
    );
    return queued;
  }

  private async ensure(kind: string): Promise<string> {
    const failed = await installAdapter(kind);
    if (failed !== null) throw new Error(failed);
    const found = await locate(kind);
    if (found !== null) return found;
    const installing = this.installing.catch(() => undefined).then(() => installCli(kind));
    this.installing = installing;
    const failure = await installing;
    if (failure !== null) throw new Error(failure);
    const installed = await locate(kind);
    if (installed === null) throw new Error(`the login shell does not find ${CLIS[kind]!.bin} after its install`);
    return installed;
  }

  private async resolve(kind: string): Promise<{ cli: string; release: string } | Reading> {
    let cli: string;
    try {
      cli = await realpath(await this.ensure(kind));
    } catch (error) {
      const failure = causeOf(error);
      process.stderr.write(`kit: ${kind} did not install: ${failure}\n`);
      return { release: null, failure, ...SIGNED_OUT };
    }
    const release = await versionOf(cli);
    if (release === null) return { release: null, failure: `${cli} --version names no version`, ...SIGNED_OUT };
    const minimum = CLIS[kind]!.minimum;
    if (below(release, minimum)) return { release, minimum, failure: null, ...SIGNED_OUT };
    return { cli, release };
  }

  private async examine(
    kind: string,
    known: Offer,
    read: (kind: string, cli: string, known: Offer) => Promise<Offer>,
  ): Promise<void> {
    const current = this.nextRead(kind);
    const resolved = await this.queue(kind, () => this.resolve(kind));
    const reading =
      'cli' in resolved ? { release: resolved.release, failure: null, ...(await read(kind, resolved.cli, known)) } : resolved;
    if (this.reads.get(kind) === current) this.readings.set(kind, reading);
  }

  private async load(kind: string): Promise<void> {
    const known = this.readings.get(kind);
    if (known !== undefined && known.failure === null) return;
    await this.examine(kind, SIGNED_OUT, offer);
  }

  private async send(): Promise<void> {
    const agents = this.desired.agents.flatMap((kind) => {
      const reading = this.readings.get(kind);
      return reading === undefined ? [] : [reported(kind, reading)];
    });
    const hostKey = await sshHostKey();
    const body = {
      os: await operatingSystem(),
      kit_version: KIT_VERSION,
      agent_base: agentBase(),
      agents,
      ...(hostKey === null ? {} : { ssh_host_key: hostKey }),
    };
    const state = JSON.stringify(body);
    if (state === this.sent) return;
    await this.house.deliver('/kit/agents/report', body);
    this.sent = state;
  }
}
