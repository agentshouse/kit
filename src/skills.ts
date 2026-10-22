import { cp, lstat, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { GUIDE, listSkills } from '@agentshouse/skills';
import { parse } from 'yaml';
import { KIT_RELEASE } from './clis.ts';
import { kitHome, readConfiguration, readHome, writeHome } from './home.ts';

interface Installed {
  version?: string;
  names: string[];
}

interface Skill {
  name: string;
  place(destination: string): Promise<void>;
}

const RECORD = 'skill-set.json';
const ENTRY = 'SKILL.md';
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/u;
const ORIGIN = '<origin>';

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

function skillName(text: string): string | undefined {
  const front = FRONTMATTER.exec(text);
  const fields = (front === null ? null : parse(front[1]!)) as { name?: unknown; description?: unknown } | null;
  return typeof fields?.name === 'string' && typeof fields.description === 'string' ? fields.name : undefined;
}

function skillSet(origin: string): Skill[] {
  const upstream = listSkills().map(({ name, directory }) => ({
    name,
    place: (destination: string) => cp(directory, destination, { recursive: true }),
  }));
  const pages = GUIDE.flatMap(({ text }) => {
    const name = skillName(text);
    if (name === undefined) return [];
    const place = async (destination: string) => {
      await mkdir(destination);
      await writeFile(join(destination, ENTRY), text.replaceAll(ORIGIN, origin));
    };
    return [{ name, place }];
  });
  return [...upstream, ...pages].sort((left, right) => (left.name < right.name ? -1 : 1));
}

async function install(origin: string): Promise<void> {
  const placed: Skill[] = [];
  for (const skill of skillSet(origin)) {
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
  for (const { name, place } of placed) {
    await place(join(skillsDirectory(), name));
    if (claude !== skills) await symlink(relative(claude, join(skills, name)), join(claudeDirectory(), name));
  }
  await writeHome(RECORD, { version: KIT_RELEASE, names } satisfies Installed);
}

export async function placeSkillSet(origin: string): Promise<void> {
  try {
    await replaceSkillSet(origin);
  } catch (error) {
    process.stderr.write(`kit: the skills could not be placed: ${(error as Error).message}\n`);
  }
}

async function replaceSkillSet(origin: string): Promise<void> {
  const accepted = (await readConfiguration()).skills;
  const installed = await readHome<Installed>(RECORD);
  if (accepted && installed?.version === KIT_RELEASE) return;
  for (const name of installed?.names ?? []) {
    await rm(join(claudeDirectory(), name), { recursive: true, force: true });
    await rm(join(skillsDirectory(), name), { recursive: true, force: true });
  }
  if (accepted) await install(origin);
  else await rm(join(kitHome(), RECORD), { force: true });
}
