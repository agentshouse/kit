import { cp, lstat, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { listSkills, type Skill } from '@agentshouse/skills';
import { KIT_RELEASE } from './clis.ts';
import { kitHome, readConfiguration, readHome, writeHome } from './home.ts';

interface Installed {
  version?: string;
  names: string[];
}

const RECORD = 'skill-set.json';

function skillsDirectory(): string {
  return join(homedir(), '.agents', 'skills');
}

function claudeDirectory(): string {
  return join(homedir(), '.claude', 'skills');
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function install(): Promise<void> {
  const placed: Skill[] = [];
  for (const skill of listSkills()) {
    if (!(await present(join(skillsDirectory(), skill.name))) && !(await present(join(claudeDirectory(), skill.name)))) {
      placed.push(skill);
    }
  }
  const names = placed.map((skill) => skill.name);
  await writeHome(RECORD, { names } satisfies Installed);
  await mkdir(skillsDirectory(), { recursive: true });
  await mkdir(claudeDirectory(), { recursive: true });
  const skills = await realpath(skillsDirectory());
  const claude = await realpath(claudeDirectory());
  for (const { name, directory } of placed) {
    await cp(directory, join(skillsDirectory(), name), { recursive: true });
    if (claude !== skills) await symlink(relative(claude, join(skills, name)), join(claudeDirectory(), name));
  }
  await writeHome(RECORD, { version: KIT_RELEASE, names } satisfies Installed);
}

export async function placeSkillSet(): Promise<void> {
  try {
    await replaceSkillSet();
  } catch (error) {
    process.stderr.write(`kit: the skills could not be placed: ${(error as Error).message}\n`);
  }
}

async function replaceSkillSet(): Promise<void> {
  const accepted = (await readConfiguration()).skills;
  const installed = await readHome<Installed>(RECORD);
  if (accepted && installed?.version === KIT_RELEASE) return;
  for (const name of installed?.names ?? []) {
    await rm(join(claudeDirectory(), name), { recursive: true, force: true });
    await rm(join(skillsDirectory(), name), { recursive: true, force: true });
  }
  if (accepted) await install();
  else await rm(join(kitHome(), RECORD), { force: true });
}
