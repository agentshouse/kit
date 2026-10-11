import { existsSync, linkSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  user: string;
  credential: string;
}

const ENROLMENT = 'credential.json';
const DISCONNECTED = 'disconnected.json';
const CONFIGURATION = 'kit.json';
const OWN_AGENT = 'own-agent.json';
const RESTART = 'restart';

export function kitHome(): string {
  return process.env.HOUSE_KIT_HOME ?? join(homedir(), '.house-kit');
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
  const temporary = join(home, `${name}.${process.pid}`);
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
