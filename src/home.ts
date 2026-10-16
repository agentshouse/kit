import { createHash, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectRelay } from './relay.ts';

export interface Enrolment {
  house: string;
  relay?: string;
  environment: string;
  credential: string;
}

export interface Configuration {
  skills: boolean;
}

export interface OwnAgent {
  house: string;
  relay?: string;
  user?: string;
  credential: string;
}

const ENROLMENT = 'credential.json';
const DISCONNECTED = 'disconnected.json';
const CONFIGURATION = 'kit.json';
const OWN_AGENT = 'own-agent.json';
const RESTART = 'restart';

let defaulted: string | undefined;

function writable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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

function ownTemporaryHome(): string {
  return privateDirectory(join(tmpdir(), `house-kit-${process.getuid!()}`));
}

function defaultHome(): string {
  const home = join(homedir(), '.house-kit');
  return existsSync(home) || writable(homedir()) ? home : ownTemporaryHome();
}

export function kitHome(): string {
  return process.env.HOUSE_KIT_HOME || (defaulted ??= defaultHome());
}

export function socketDirectory(): string {
  const sockets = privateDirectory(join(realpathSync('/tmp'), `hk-${process.geteuid!()}`));
  return privateDirectory(join(sockets, createHash('sha256').update(resolve(kitHome())).digest('hex').slice(0, 12)));
}

export function ownerSocket(): string {
  return join(socketDirectory(), 'owner.sock');
}

export function workspaceRoot(): string {
  return process.env.HOUSE_KIT_WORKSPACE ?? '/agents/house';
}

export function agentBase(): string {
  return join(workspaceRoot(), 'agents');
}

export async function readHome<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(kitHome(), name), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeHome(name: string, value: unknown): Promise<void> {
  const home = kitHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `${name}.${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, join(home, name));
}

export async function readEnrolment(): Promise<Enrolment | null> {
  const enrolment = await readHome<Enrolment>(ENROLMENT);
  if (enrolment !== null) selectRelay(process.env.HOUSE_KIT_RELAY || enrolment.relay);
  return enrolment;
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
  if ((JSON.parse(readFileSync(taken, 'utf8')) as Enrolment).credential !== rejected) {
    try {
      linkSync(taken, enrolment);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    rmSync(join(kitHome(), DISCONNECTED), { force: true });
  }
  rmSync(taken);
}

export function enrolled(): boolean {
  return existsSync(join(kitHome(), ENROLMENT));
}

export function restartAsked(): boolean {
  return existsSync(join(kitHome(), RESTART));
}

export function forgetRestart(): Promise<void> {
  return rm(join(kitHome(), RESTART), { force: true });
}

export function readOwnAgent(): Promise<OwnAgent | null> {
  return readHome<OwnAgent>(OWN_AGENT);
}

export function writeOwnAgent(ownAgent: OwnAgent): Promise<void> {
  return writeHome(OWN_AGENT, ownAgent);
}

export function forgetOwnAgent(): Promise<void> {
  return rm(join(kitHome(), OWN_AGENT), { force: true });
}

export async function readConfiguration(): Promise<Configuration> {
  return { skills: (await readHome<Partial<Configuration>>(CONFIGURATION))?.skills !== false };
}

export function writeConfiguration(configuration: Configuration): Promise<void> {
  return writeHome(CONFIGURATION, configuration);
}
