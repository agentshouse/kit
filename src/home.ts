import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Enrolment {
  house: string;
  environment: string;
  credential: string;
}

export interface Configuration {
  skills: boolean;
}

const ENROLMENT = 'credential.json';
const CONFIGURATION = 'kit.json';

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

export function readEnrolment(): Promise<Enrolment | null> {
  return readHome<Enrolment>(ENROLMENT);
}

export function writeEnrolment(enrolment: Enrolment): Promise<void> {
  return writeHome(ENROLMENT, enrolment);
}

export async function readConfiguration(): Promise<Configuration> {
  return { skills: (await readHome<Partial<Configuration>>(CONFIGURATION))?.skills !== false };
}

export function writeConfiguration(configuration: Configuration): Promise<void> {
  return writeHome(CONFIGURATION, configuration);
}
