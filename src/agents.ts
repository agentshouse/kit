import { client, type SessionConfigOption, type SessionConfigSelectOptions } from '@agentclientprotocol/sdk';
import { KIT_WIRE, type DesiredAgentRoute, type KitActAnswer, type KitActRequest, type ReportedAgentKind } from '@agentshouse/kit-wire';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { signedOut, startAdapter, type Adapter } from './acp.ts';
import type { House } from './api.ts';
import { CLIS, KIT_RELEASE, below, installCli, locate, run, updateCli, versionOf } from './clis.ts';
import { agentBase, kitHome } from './home.ts';
import { holdTranscription, transcriptionReport } from './transcription.ts';

type Model = ReportedAgentKind['models'][number];

type Offer = Pick<ReportedAgentKind, 'signed_in' | 'models' | 'modes'> & { default_model: string | null; default_effort: string | null };

type Reading = Offer & Pick<ReportedAgentKind, 'release' | 'failure' | 'installing'>;

// Two quiet seconds let a fresh conversation start before background model discovery competes for its CPU.
const MODEL_PROBE_QUIET_MS = 2_000;

// A CLI's maker can publish several releases a day, so running each chosen CLI's update command hourly brings a new one to the next conversation within the hour for one small check.
export const CLI_UPDATE_MS = 60 * 60_000;

// A sign-in's model read that has not answered in ten seconds leaves its sign-in to the status check, so a hung CLI never holds the sign-in's result.
const SIGNED_IN_READ_MS = 10_000;

const UNNAMED = { default_model: null, default_effort: null };

const SIGNED_OUT: Offer = { signed_in: false, models: [], ...UNNAMED, modes: [] };

const INSTALLING: Reading = { release: null, failure: null, installing: true, ...SIGNED_OUT };

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

const CLI_DEFAULT = 'default';

function effortsOf(option: ReturnType<typeof select>): string[] {
  return option === undefined ? [] : values(option.options).filter((value) => value !== CLI_DEFAULT);
}

function named(options: SessionConfigSelectOptions) {
  const listed = choices(options).filter((entry) => entry.value !== CLI_DEFAULT);
  return listed.filter((entry, at) => listed.findIndex((first) => first.name === entry.name) === at);
}

function starting(model: NonNullable<ReturnType<typeof select>>, effort: ReturnType<typeof select>): Pick<Offer, 'default_model' | 'default_effort'> {
  const current = choices(model.options).find((entry) => entry.value === model.currentValue);
  const name = current?.value === CLI_DEFAULT ? current.description : current?.name;
  return {
    default_model: named(model.options).find((entry) => entry.name === name)?.value ?? null,
    default_effort: effort === undefined || effort.currentValue === CLI_DEFAULT ? null : effort.currentValue,
  };
}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

type Form = NonNullable<KitActRequest<'agents/report'>['form']>;

const LAPTOP_CHASSIS = new Set(['8', '9', '10', '14', '30', '31', '32']);
const DESKTOP_CHASSIS = new Set(['3', '4', '5', '6', '7', '15', '16']);
const SERVER_CHASSIS = new Set(['17', '18', '19', '20', '21', '22', '23', '24']);

export function chassisForm(value: string): Form | undefined {
  const chassis = value.trim();
  if (LAPTOP_CHASSIS.has(chassis)) return 'laptop';
  if (DESKTOP_CHASSIS.has(chassis)) return 'desktop';
  if (SERVER_CHASSIS.has(chassis)) return 'server';
  return undefined;
}

export function hostVm(version: string): boolean {
  return /docker desktop|microsoft|wsl|linuxkit/i.test(version);
}

async function models(kind: string, adapter: Adapter, known: Model[]): Promise<Omit<Offer, 'signed_in'>> {
  const agent = adapter.connection.agent;
  const opened = await agent.request('session/new', { cwd: kitHome(), mcpServers: [] });
  let options = opened.configOptions ?? [];
  const mode = select(options, 'mode');
  const modes = mode === undefined ? [] : choices(mode.options).map(({ value, name }) => ({ mode: value, name }));
  const model = select(options, 'model');
  if (model === undefined) return { models: [], ...UNNAMED, modes };
  const started = starting(model, select(options, 'thought_level'));
  const offered: Model[] = [];
  for (const { value, name } of named(model.options)) {
    if (select(options, 'model')?.currentValue !== value) {
      try {
        options = (
          await agent.request('session/set_config_option', { sessionId: opened.sessionId, configId: model.id, value })
        ).configOptions;
      } catch (error) {
        process.stderr.write(`kit: ${kind} refused its model ${value}: ${causeOf(error)}\n`);
        offered.push({ model: value, name, efforts: known.find((entry) => entry.model === value)?.efforts ?? [] });
        continue;
      }
    }
    offered.push({ model: value, name, efforts: effortsOf(select(options, 'thought_level')) });
  }
  return { models: offered, ...started, modes };
}

function ended(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function offer(kind: string, cli: string, known: Offer, signal?: AbortSignal): Promise<Offer> {
  const probe = CLIS[kind]!.signedIn;
  // A sign-in check that has not answered in half a minute counts as signed out rather than stalling the report.
  if ('command' in probe && (await run(cli, probe.command, 30_000, false, signal)).status !== 0) return SIGNED_OUT;
  let adapter: Adapter | undefined;
  try {
    adapter = await startAdapter(kind, cli, kitHome(), client({ name: '@agentshouse/kit' }), () => undefined, {}, signal);
    signal?.throwIfAborted();
    if ('initializeMeta' in probe) {
      const method = adapter.initialized._meta?.[probe.initializeMeta];
      if (typeof method !== 'string' || method.length === 0) return SIGNED_OUT;
    }
    return { signed_in: true, ...(await models(kind, adapter, known.models)) };
  } catch (error) {
    if (!signal?.aborted) process.stderr.write(`kit: ${kind} did not offer its models: ${causeOf(error)}\n`);
    if (signedOut(error)) return SIGNED_OUT;
    return {
      signed_in: adapter === undefined && 'initializeMeta' in probe ? known.signed_in : true,
      models: known.models,
      default_model: known.default_model,
      default_effort: known.default_effort,
      modes: known.modes,
    };
  } finally {
    adapter?.retire();
  }
}

function reported(kind: string, reading: Reading): ReportedAgentKind {
  const { minimum, update } = CLIS[kind]!;
  return {
    kind,
    release: reading.release,
    ...(reading.release !== null && below(reading.release, minimum) ? { minimum, update } : {}),
    failure: reading.failure,
    ...(reading.installing === undefined ? {} : { installing: reading.installing }),
    signed_in: reading.signed_in,
    models: reading.models,
    modes: reading.modes,
    full_access: CLIS[kind]!.fullAccess,
    ...(reading.default_model === null ? {} : { default_model: reading.default_model }),
    ...(reading.default_effort === null ? {} : { default_effort: reading.default_effort }),
  };
}

const NOT_READY = "the Agent's CLI is not ready on this computer";

async function sshHostKey(): Promise<string | null> {
  // Listing a local host key takes a moment, so ten seconds only bounds a stuck ssh-keygen.
  const listed = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', '/etc/ssh/ssh_host_ed25519_key.pub'], 10_000);
  return listed.status === 0 ? (/^\d+ (SHA256:\S+)/.exec(listed.output)?.[1] ?? null) : null;
}

async function operatingSystem(): Promise<string> {
  // sw_vers answers at once, so ten seconds only bounds a stuck call.
  if (process.platform === 'darwin') return `macOS ${(await run('sw_vers', ['-productVersion'], 10_000)).output.trim()}`;
  const release = await readFile('/etc/os-release', 'utf8');
  return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)?.[1] ?? release;
}

async function hostForm(): Promise<Form | undefined> {
  if (process.platform === 'darwin') {
    const battery = await run('pmset', ['-g', 'batt'], 10_000);
    return battery.status === 0 && battery.output.includes('InternalBattery') ? 'laptop' : 'desktop';
  }
  if (process.platform !== 'linux') return undefined;
  const [container, version, chassis] = await Promise.all([
    readFile('/.dockerenv', 'utf8').then(() => true).catch(() => false),
    readFile('/proc/version', 'utf8').catch(() => ''),
    readFile('/sys/class/dmi/id/chassis_type', 'utf8').catch(() => ''),
  ]);
  if (container && hostVm(version)) return undefined;
  return chassisForm(chassis);
}

export class Agents {
  desired: KitActAnswer<'agents/desired/list'> = { agents: [], routes: [], transcribe: false };
  private readonly house: House;
  private reading: Promise<unknown> = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();
  private installing: Promise<unknown> = Promise.resolve();
  private readonly installs = new Map<string, object>();
  private readonly readings = new Map<string, Reading>();
  private readonly reads = new Map<string, number>();
  private starts = 0;
  private sending: Promise<void> = Promise.resolve();
  private sent: string | null = null;
  private refreshing = 0;
  private loaded: Promise<unknown> = Promise.resolve();
  private updating: Promise<void> | null = null;
  private readonly changed: () => void;

  constructor(house: House, changed: () => void = () => undefined) {
    this.house = house;
    this.changed = changed;
  }

  idle(): boolean {
    return this.refreshing === 0 && this.updating === null;
  }

  read(): Promise<void> {
    return this.reading.then(
      () => undefined,
      () => undefined,
    );
  }

  route(agentId: string): DesiredAgentRoute | undefined {
    return this.desired.routes.find((route) => route.agent_id === agentId);
  }

  refresh(): Promise<void> {
    this.refreshing++;
    this.changed();
    const reading = this.read().then(async () => {
      this.desired = await this.house.deliver('agents/desired/list', {});
      return this.desired;
    });
    this.reading = reading;
    this.loaded = reading
      .then(({ agents, transcribe }) =>
        Promise.all([
          holdTranscription(transcribe)
            .then((changed) => (changed ? this.report() : undefined))
            .catch(logged),
          Promise.all(agents.map((kind) => this.load(kind)))
            .then(() => this.report())
            .catch(logged),
        ]),
      )
      .catch(() => undefined)
      .finally(() => {
        this.refreshing--;
        this.changed();
      });
    return reading.then(() => undefined);
  }

  keepCurrent(stopping: () => boolean): void {
    this.updateAll(this.loaded);
    setInterval(() => {
      if (!stopping()) this.updateAll(Promise.resolve());
    }, CLI_UPDATE_MS);
  }

  cli(kind: string): Promise<string> {
    this.starts += 1;
    return this.queue(kind, async () => {
      const resolved = await this.resolve(kind);
      if (!('cli' in resolved)) {
        this.update(kind, resolved);
        throw new Error(NOT_READY);
      }
      const { cli, release } = resolved;
      const known = this.readings.get(kind);
      const kept = known?.release === null ? SIGNED_OUT : (known ?? SIGNED_OUT);
      if (known?.release !== release || this.installs.has(kind)) {
        this.update(kind, {
          release,
          failure: null,
          signed_in: kept.signed_in,
          models: kept.models,
          default_model: kept.default_model,
          default_effort: kept.default_effort,
          modes: kept.modes,
        });
      }
      const read = this.nextRead(kind);
      this.quietOffer(kind, cli, kept)
        .then((offered) => {
          const current = this.readings.get(kind);
          if (this.reads.get(kind) === read && current?.release === release) this.update(kind, { ...current, ...offered });
        })
        .catch(logged);
      return cli;
    });
  }

  located(kind: string, signal: AbortSignal): Promise<string> {
    const owner = {};
    return this.queue(kind, () => this.ensure(kind, signal, owner).finally(() => this.settle(kind, owner)), signal);
  }

  async reread(kind: string): Promise<void> {
    await this.examine(kind, this.readings.get(kind) ?? SIGNED_OUT, offer);
    await this.report();
  }

  async recheck(kind: string, signal: AbortSignal): Promise<void> {
    const known = this.readings.get(kind) ?? SIGNED_OUT;
    const owner = {};
    try {
      await this.examine(
        kind,
        known,
        (kind, cli) => offer(kind, cli, known, AbortSignal.any([signal, AbortSignal.timeout(SIGNED_IN_READ_MS)])),
        signal,
        owner,
      );
    } finally {
      this.settle(kind, owner);
    }
    if (!signal.aborted) await this.report();
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

  private hold(kind: string, reading: Reading): void {
    this.readings.set(kind, reading);
    this.installs.delete(kind);
  }

  private update(kind: string, reading: Reading): void {
    this.hold(kind, reading);
    this.report().catch(logged);
  }

  private settle(kind: string, owner: object): void {
    if (this.installs.get(kind) !== owner) return;
    this.installs.delete(kind);
    this.report().catch(logged);
  }

  private queue<T>(kind: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queued = (this.queues.get(kind) ?? Promise.resolve()).then(() => {
      signal?.throwIfAborted();
      return work();
    });
    this.queues.set(
      kind,
      queued.catch(() => undefined),
    );
    return signal === undefined ? queued : Promise.race([queued, ended(signal)]);
  }

  private async ensure(kind: string, signal?: AbortSignal, owner: object = {}): Promise<string> {
    const found = await locate(kind, signal);
    if (found !== null) return found;
    this.installs.set(kind, owner);
    this.report().catch(logged);
    const installing = this.installing.catch(() => undefined).then(() => installCli(kind, signal));
    this.installing = installing;
    const failure = await installing;
    if (failure !== null) throw new Error(failure);
    const installed = await locate(kind, signal);
    if (installed === null) throw new Error(`the login shell does not find ${CLIS[kind]!.bin} after its install`);
    return installed;
  }

  private async resolve(
    kind: string,
    signal?: AbortSignal,
    owner?: object,
  ): Promise<{ cli: string; release: string } | Reading> {
    let cli: string;
    try {
      cli = await this.ensure(kind, signal, owner);
    } catch (error) {
      const failure = causeOf(error);
      process.stderr.write(`kit: ${kind} did not install: ${failure}\n`);
      return { release: null, failure, ...SIGNED_OUT };
    }
    const release = await versionOf(cli, signal);
    if (release === null) return { release: null, failure: `${cli} --version names no version`, ...SIGNED_OUT };
    return { cli, release };
  }

  private async examine(
    kind: string,
    known: Offer,
    read: (kind: string, cli: string, known: Offer) => Promise<Offer>,
    signal?: AbortSignal,
    owner?: object,
  ): Promise<void> {
    const current = this.nextRead(kind);
    const resolved = await this.queue(kind, () => this.resolve(kind, signal, owner), signal);
    const reading =
      'cli' in resolved ? { release: resolved.release, failure: null, ...(await read(kind, resolved.cli, known)) } : resolved;
    if (this.reads.get(kind) === current && !signal?.aborted) this.hold(kind, reading);
  }

  private updateAll(after: Promise<unknown>): void {
    if (this.updating !== null) return;
    this.updating = after
      .then(async () => {
        for (const kind of this.desired.agents) {
          if (this.installs.has(kind) || !this.readings.get(kind)?.release) continue;
          const failure = await updateCli(kind);
          if (failure !== null) process.stderr.write(`kit: ${kind} did not update: ${failure}\n`);
          await this.readVersion(kind);
        }
      })
      .catch(logged)
      .finally(() => {
        this.updating = null;
        this.changed();
      });
    this.changed();
  }

  private async readVersion(kind: string): Promise<void> {
    const cli = await locate(kind);
    const release = cli === null ? null : await versionOf(cli);
    const current = this.readings.get(kind);
    if (release === null || !current?.release || current.release === release) return;
    this.update(kind, { ...current, release });
  }

  private async quietOffer(kind: string, cli: string, known: Offer): Promise<Offer> {
    for (let seen = -1; seen !== this.starts; ) {
      seen = this.starts;
      await delay(MODEL_PROBE_QUIET_MS);
    }
    return offer(kind, cli, known);
  }

  private async load(kind: string): Promise<void> {
    const known = this.readings.get(kind);
    if (known !== undefined && known.failure === null) return;
    await this.examine(kind, SIGNED_OUT, (kind, cli, known) => this.quietOffer(kind, cli, known));
    await this.report();
  }

  private async send(): Promise<void> {
    const agents = this.desired.agents.flatMap((kind) => {
      const reading = this.installs.has(kind) ? INSTALLING : this.readings.get(kind);
      return reading === undefined ? [] : [reported(kind, reading)];
    });
    const hostKey = await sshHostKey();
    const form = await hostForm();
    const body = {
      os: await operatingSystem(),
      ...(form === undefined ? {} : { form }),
      kit_release: KIT_RELEASE,
      wire: KIT_WIRE,
      agent_base: agentBase(),
      agents,
      transcription: transcriptionReport(),
      ...(hostKey === null ? {} : { ssh_host_key: hostKey }),
    };
    const state = JSON.stringify(body);
    if (state === this.sent) return;
    await this.house.deliver('agents/report', body);
    this.sent = state;
  }
}
