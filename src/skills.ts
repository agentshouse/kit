import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { KitSkills } from '@agentshouse/kit-wire';
import { GUIDE, listSkills } from '@agentshouse/skills';
import { parse } from 'yaml';
import { KIT_RELEASE } from './clis.ts';
import { kitHome, readConfiguration, readEnrolment, readHome, writeHome } from './home.ts';
import { answerDocument, environmentTool } from './mcp.ts';

interface Installed {
  version?: string;
  origin?: string;
  digest?: string;
  names: string[];
}

interface Skill {
  name: string;
  files: Readonly<Record<string, string>> | null;
  place(destination: string): Promise<void>;
}

interface Catalogued {
  name: string;
  own?: true;
}

interface Paged {
  next_cursor?: string;
}

interface Catalogue extends Paged {
  catalogue: Catalogued[];
}

interface Answered extends Paged {
  skills: { files: Record<string, unknown> }[];
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

function houseSkills(origin: string): Map<string, Skill> {
  const upstream = listSkills().map(({ name, directory }) => ({
    name,
    files: null,
    place: (destination: string) => cp(directory, destination, { recursive: true }),
  }));
  const pages = GUIDE.flatMap(({ text }) => {
    const name = skillName(text);
    if (name === undefined) return [];
    const place = async (destination: string) => {
      await mkdir(destination);
      await writeFile(join(destination, ENTRY), text.replaceAll(ORIGIN, origin));
    };
    return [{ name, files: null, place }];
  });
  return new Map([...upstream, ...pages].map((skill) => [skill.name, skill]));
}

function ownSkill(name: string, files: Readonly<Record<string, string>>): Skill {
  const place = async (destination: string) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await writeFile(join(destination, path), text);
    }
  };
  return { name, files, place };
}

async function paged<T extends Paged>(args: Record<string, unknown>): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | undefined;
  do {
    const page = answerDocument<T>(await environmentTool('guide', { op: 'skill', ...args, ...(cursor === undefined ? {} : { cursor }) }));
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  return pages;
}

async function ownFiles(name: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const page of await paged<Answered>({ names: [name] })) {
    for (const skill of page.skills) {
      for (const [path, text] of Object.entries(skill.files)) if (typeof text === 'string') files[path] = (files[path] ?? '') + text;
    }
  }
  return files;
}

async function wanted(setting: KitSkills, origin: string): Promise<Skill[]> {
  if (setting !== 'all' && setting.length === 0) return [];
  const catalogue = (await paged<Catalogue>({})).flatMap((page) => page.catalogue);
  const chosen = setting === 'all' ? catalogue : catalogue.filter(({ name }) => setting.includes(name));
  const own = new Map<string, Record<string, string>>();
  for (const { name } of chosen.filter((skill) => skill.own === true)) own.set(name, await ownFiles(name));
  const house = houseSkills(origin);
  return chosen
    .flatMap(({ name }) => {
      const files = own.get(name);
      const skill = files === undefined ? house.get(name) : ownSkill(name, files);
      return skill === undefined ? [] : [skill];
    })
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

function digestOf(origin: string, skills: readonly Skill[]): string {
  const held = skills.map(({ name, files }) => [name, files]);
  return createHash('sha256').update(JSON.stringify([origin, held])).digest('hex');
}

async function install(origin: string, skills: readonly Skill[], digest: string): Promise<void> {
  const placed: Skill[] = [];
  for (const skill of skills) {
    if (!(await present(join(skillsDirectory(), skill.name))) && !(await present(join(claudeDirectory(), skill.name)))) {
      placed.push(skill);
    }
  }
  const names = placed.map((skill) => skill.name);
  await writeHome(RECORD, { names } satisfies Installed);
  await mkdir(skillsDirectory(), { recursive: true });
  await mkdir(claudeDirectory(), { recursive: true });
  const shared = await realpath(skillsDirectory());
  const claude = await realpath(claudeDirectory());
  for (const { name, place } of placed) {
    await place(join(skillsDirectory(), name));
    if (claude !== shared) await symlink(relative(claude, join(shared, name)), join(claudeDirectory(), name));
  }
  await writeHome(RECORD, { version: KIT_RELEASE, origin, digest, names } satisfies Installed);
}

async function replaced(): Promise<void> {
  const enrolment = await readEnrolment();
  if (enrolment === null) return;
  const skills = await wanted((await readConfiguration()).skills, enrolment.house);
  const digest = digestOf(enrolment.house, skills);
  const installed = await readHome<Installed>(RECORD);
  if (installed?.version === KIT_RELEASE && installed.digest === digest) return;
  for (const name of installed?.names ?? []) {
    await rm(join(claudeDirectory(), name), { recursive: true, force: true });
    await rm(join(skillsDirectory(), name), { recursive: true, force: true });
  }
  if (skills.length > 0) await install(enrolment.house, skills, digest);
  else await rm(join(kitHome(), RECORD), { force: true });
}

async function reported(): Promise<void> {
  try {
    await replaced();
  } catch (error) {
    process.stderr.write(`kit: the skills could not be placed: ${(error as Error).message}\n`);
  }
}

let latest: Promise<void> = Promise.resolve();
let queued: Promise<void> | null = null;

export function placeSkills(): Promise<void> {
  queued ??= latest.then(() => {
    queued = null;
    return reported();
  });
  latest = queued;
  return queued;
}
