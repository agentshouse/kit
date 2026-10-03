import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Enrolment {
  house: string;
  environment: string;
  credential: string;
}

const ENROLMENT = 'credential.json';

export function kitHome(): string {
  return process.env.HOUSE_KIT_HOME ?? join(homedir(), '.house-kit');
}

export async function readEnrolment(): Promise<Enrolment | null> {
  try {
    return JSON.parse(await readFile(join(kitHome(), ENROLMENT), 'utf8')) as Enrolment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeEnrolment(enrolment: Enrolment): Promise<void> {
  const home = kitHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `${ENROLMENT}.${process.pid}`);
  await writeFile(temporary, `${JSON.stringify(enrolment)}\n`, { mode: 0o600 });
  await rename(temporary, join(home, ENROLMENT));
}
