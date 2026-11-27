import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { KitSkills } from '@agentshouse/kit-wire';
import { ROOMS, writeRoomPath } from '@agentshouse/mdmodel';

export interface Enrolment {
  house: string;
  environment: string;
  credential: string;
}

export interface Configuration {
  skills: KitSkills;
  workspace: string;
}

type Stored = Partial<Omit<Configuration, 'skills'>> & { skills?: KitSkills | boolean } & Record<string, unknown>;

const ENROLMENT = 'credential.json';
const DISCONNECTED = 'disconnected.json';
const CONFIGURATION = 'kit.json';
const PLANNED_RESTART = 'planned-restart';

const EARLIER_PREFIXES = ['/kit-home/kit', '/opt/house-kit'];

function privateDirectory(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const found = lstatSync(path);
  if (found.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!found.isDirectory()) throw new Error(`${path} is not a directory`);
  if (found.uid !== process.geteuid!()) throw new Error(`${path} is not owned by this User`);
  chmodSync(path, 0o700);
  return path;
}

export function oneFolder(account = homedir()): string {
  return join(account, '.agents', 'house');
}

export function houseFolder(account = homedir()): string {
  return join(account, 'house');
}

export function desktopPrefix(): string {
  return join(homedir(), '.local', 'share', 'house-kit');
}

export function earlierPrefix(): string | null {
  const prefix = process.env.HOUSE_KIT_PREFIX;
  if (prefix === undefined || prefix === '') return null;
  return [...EARLIER_PREFIXES, desktopPrefix()].includes(resolve(prefix)) ? resolve(prefix) : null;
}

export function awaitsTakeover(): boolean {
  const prefix = earlierPrefix();
  return prefix === EARLIER_PREFIXES[0] || (prefix === EARLIER_PREFIXES[1] && process.getuid!() !== 0);
}

export function earlierHome(): string {
  return process.env.HOUSE_KIT_HOME || join(homedir(), '.house-kit');
}

export function reinstall(): 'linux' | 'windows' | undefined {
  if (!awaitsTakeover()) return undefined;
  try {
    return readFileSync(join(earlierHome(), 'placement'), 'utf8').trim() === 'windows' ? 'windows' : 'linux';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'linux';
    throw error;
  }
}

export function kitHome(): string {
  return earlierPrefix() === null ? oneFolder() : earlierHome();
}

export function socketDirectory(): string {
  const sockets = privateDirectory(join(realpathSync('/tmp'), `hk-${process.geteuid!()}`));
  const home = kitHome();
  const physical = existsSync(home) ? realpathSync(home) : resolve(home);
  return privateDirectory(join(sockets, createHash('sha256').update(physical).digest('hex').slice(0, 12)));
}

export function ownerSocket(): string {
  return join(socketDirectory(), 'owner.sock');
}

export function ownerLock(): string {
  return join(socketDirectory(), 'owner.lock');
}

export function workspaceRoot(): string {
  if (earlierPrefix() !== null) return process.env.HOUSE_KIT_WORKSPACE ?? '/agents/house';
  return configuredWorkspace() ?? houseFolder();
}

export function agentBase(): string {
  return join(workspaceRoot(), 'agents');
}

export function roomsFolder(): string {
  return join(workspaceRoot(), ROOMS);
}

export function roomFolder(handle: string): string {
  return join(workspaceRoot(), writeRoomPath({ handle, path: '' }));
}

export function conversationsFolder(): string {
  return join(workspaceRoot(), 'conversations');
}

export function repositoriesFolder(): string {
  return join(workspaceRoot(), 'repositories');
}

function parsed<T>(name: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} in Kit home holds no JSON`);
  }
}

export async function readHome<T>(name: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(join(kitHome(), name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parsed<T>(name, text);
}

export async function writeHome(name: string, value: unknown): Promise<void> {
  const home = kitHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `${name}.${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, join(home, name));
}

export function readEnrolment(): Promise<Enrolment | null> {
  return readHome<Enrolment>(ENROLMENT);
}

export async function writeEnrolment(enrolment: Enrolment): Promise<void> {
  await writeHome(ENROLMENT, enrolment);
  await rm(join(kitHome(), DISCONNECTED), { force: true });
}

export function readDisconnected(): Promise<Omit<Enrolment, 'credential'> | null> {
  return readHome(DISCONNECTED);
}

export function forgetDisconnected(): Promise<void> {
  return rm(join(kitHome(), DISCONNECTED), { force: true });
}

export async function forgetEnrolment({ house, environment }: Enrolment): Promise<void> {
  await writeHome(DISCONNECTED, { house, environment });
  await rm(join(kitHome(), ENROLMENT), { force: true });
}

export async function forgetRejected(rejected: string): Promise<void> {
  const held = await readHome<Enrolment>(ENROLMENT);
  if (held?.credential !== rejected) return;
  await writeHome(DISCONNECTED, { house: held.house, environment: held.environment });
  const enrolment = join(kitHome(), ENROLMENT);
  const taken = `${enrolment}.${process.pid}`;
  try {
    renameSync(enrolment, taken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (parsed<Enrolment>(ENROLMENT, readFileSync(taken, 'utf8')).credential !== rejected) {
    try {
      linkSync(taken, enrolment);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    rmSync(join(kitHome(), DISCONNECTED), { force: true });
  }
  rmSync(taken);
}

export function recordPlannedRestart(): void {
  writeFileSync(join(kitHome(), PLANNED_RESTART), '', { mode: 0o600 });
}

export function takePlannedRestart(): boolean {
  try {
    unlinkSync(join(kitHome(), PLANNED_RESTART));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function enrolled(): boolean {
  return existsSync(join(kitHome(), ENROLMENT));
}

export async function forgetRecordedRelay(): Promise<string | null> {
  const held = await readHome<Record<string, unknown>>(ENROLMENT);
  if (held === null || !('relay' in held)) return null;
  const { relay, ...kept } = held;
  await writeHome(ENROLMENT, kept);
  return String(relay);
}

function configuredWorkspace(): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(kitHome(), CONFIGURATION), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parsed<Stored>(CONFIGURATION, text).workspace;
}

function skillsOf(stored: KitSkills | boolean | undefined): KitSkills {
  if (stored === false) return [];
  return stored === undefined || stored === true ? 'all' : stored;
}

export async function readConfiguration(): Promise<Configuration> {
  const stored = await readHome<Stored>(CONFIGURATION);
  return { skills: skillsOf(stored?.skills), workspace: stored?.workspace ?? houseFolder() };
}

export async function storedConfiguration(): Promise<Stored> {
  return (await readHome<Stored>(CONFIGURATION)) ?? {};
}

export function writeConfiguration(configuration: Stored): Promise<void> {
  return writeHome(CONFIGURATION, configuration);
}
