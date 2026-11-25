import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { KitSkills } from '@agentshouse/kit-wire';
import { GUIDE, listSkills, readSkill } from '@agentshouse/skills';
import { parse } from 'yaml';
import { KIT_RELEASE } from './clis.ts';
import { fetched } from './files.ts';
import { frontmatter } from './frontmatter.ts';
import { kitHome, readConfiguration, readEnrolment, readHome, writeHome } from './home.ts';
import { answerDocument, environmentTool } from './mcp.ts';

interface Installed {
  version?: string;
  origin?: string;
  digest?: string;
  names: string[];
}

type SkillFile = string | Buffer;

interface Skill {
  name: string;
  files: Readonly<Record<string, SkillFile>>;
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

type Values = Record<string, unknown>;

interface SkillAnswer {
  name?: unknown;
  own?: unknown;
  files?: Values;
  attachments?: Values;
}

interface SkillsAnswer extends Paged {
  skills?: SkillAnswer[];
}

interface AnsweredSkill {
  name: string;
  own: boolean;
  files: Record<string, string>;
  attachments: Record<string, string>;
}

type Holder = 'attachments' | 'files';

interface CutValue {
  skill: AnsweredSkill;
  holder: Holder;
  field: string;
}

export type SkillSources = Record<string, string>;

export interface RoomSkillsRecord {
  approved?: number | null;
  listed: string[];
  sources: SkillSources;
  names: string[];
  digest: string;
}

export interface RoomSkillSet {
  listed: string[];
  sources: SkillSources;
  skills: readonly Skill[];
  digest: string;
}

export interface RoomSkillsReading {
  of(room: string): Promise<RoomSkillSet>;
  sources(names: Iterable<string>): Promise<SkillSources>;
}

const RECORD = 'skill-set.json';
const ENTRY = 'SKILL.md';
const ORIGIN = '<origin>';
const CUT = 'cut';
const UNREAD = "House's answer of the skills could not be read";
const ENVIRONMENT = 'environment';

export const SKILL_FOLDERS = ['.agents/skills', '.claude/skills'];

const ROOM_SKILL_FOLDERS = SKILL_FOLDERS.map((folder) => join(...folder.split('/')));

export const NO_ROOM_SKILLS: RoomSkillSet = { listed: [], sources: {}, skills: [], digest: 'none' };

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
  const front = frontmatter(text);
  const fields = (front === null ? null : parse(front)) as { name?: unknown; description?: unknown } | null;
  return typeof fields?.name === 'string' && typeof fields.description === 'string' ? fields.name : undefined;
}

function houseSkills(origin: string): Map<string, Skill> {
  const upstream = listSkills().map(({ name, directory }) => ({
    name,
    files: Object.fromEntries(readSkill(name).map(({ path, content }) => [path, content])),
    place: (destination: string) => cp(directory, destination, { recursive: true }),
  }));
  const pages = GUIDE.flatMap(({ text }) => {
    const name = skillName(text);
    if (name === undefined) return [];
    const entry = text.replaceAll(ORIGIN, origin);
    const place = async (destination: string) => {
      await mkdir(destination);
      await writeFile(join(destination, ENTRY), entry);
    };
    return [{ name, files: { [ENTRY]: entry }, place }];
  });
  return new Map([...upstream, ...pages].map((skill) => [skill.name, skill]));
}

function ownSkill(name: string, files: Readonly<Record<string, SkillFile>>): Skill {
  const place = async (destination: string) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await writeFile(join(destination, path), content);
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

async function attached(name: string, path: string, download: string): Promise<Buffer> {
  const answer = await fetched(download);
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body) chunks.push(chunk as Buffer);
  if (answer.status !== 200) throw new Error(`the download of ${name}/${path} answered ${answer.status}`);
  return Buffer.concat(chunks);
}

async function catalogueOf(): Promise<Catalogued[]> {
  return (await paged<Catalogue>({})).flatMap((page) => page.catalogue);
}

function chosenOf(setting: KitSkills, catalogue: readonly Catalogued[]): readonly Catalogued[] {
  return setting === 'all' ? catalogue : catalogue.filter(({ name }) => setting.includes(name));
}

async function wanted(setting: KitSkills, origin: string): Promise<Skill[]> {
  if (setting !== 'all' && setting.length === 0) return [];
  const chosen = chosenOf(setting, await catalogueOf());
  const own = new Map<string, Record<string, SkillFile>>();
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

function textsOf(values: Values | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function cutField(values: Values | undefined): string | undefined {
  const cut = values?.[CUT] as { field?: unknown } | undefined;
  return typeof cut?.field === 'string' ? cut.field : undefined;
}

async function answeredSkills(args: Record<string, unknown>): Promise<AnsweredSkill[]> {
  const listed: AnsweredSkill[] = [];
  const open: CutValue[] = [];
  for (const page of await paged<SkillsAnswer>(args)) {
    if (typeof page !== 'object' || page === null) throw new Error(UNREAD);
    const answered = page.skills ?? [];
    const value = open[0];
    if (value !== undefined) {
      const values = answered[0]?.[value.holder];
      const fields = Object.keys(values ?? {}).filter((field) => field !== CUT);
      const field = fields[0]!;
      const part = values?.[field];
      const heads = value.skill[value.holder];
      if (answered.length !== 1 || answered[0]!.name !== undefined || fields.length !== 1 || typeof part !== 'string' || !(field in heads)) throw new Error(UNREAD);
      heads[field] += part;
      if (cutField(values) === undefined && field === value.field) open.shift();
      continue;
    }
    for (const answer of answered) {
      if (typeof answer.name !== 'string') throw new Error(UNREAD);
      const skill = { name: answer.name, own: answer.own === true, files: textsOf(answer.files), attachments: textsOf(answer.attachments) };
      listed.push(skill);
      for (const holder of ['attachments', 'files'] as const) {
        const field = cutField(answer[holder]);
        if (field !== undefined) open.push({ skill, holder, field });
      }
    }
  }
  if (open.length > 0) throw new Error(UNREAD);
  return listed;
}

async function skillFiles({ name, files, attachments }: AnsweredSkill): Promise<Record<string, SkillFile>> {
  const carried: Record<string, SkillFile> = { ...files };
  for (const [path, download] of Object.entries(attachments)) carried[path] = await attached(name, path, download);
  return carried;
}

async function ownFiles(name: string): Promise<Record<string, SkillFile>> {
  const [own] = await answeredSkills({ names: [name] });
  return own === undefined ? {} : skillFiles(own);
}

function remembered<T>(held: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  const known = held.get(key);
  if (known !== undefined) return known;
  const reading = read();
  held.set(key, reading);
  return reading;
}

export function roomSkillsReading(): RoomSkillsReading {
  let environment: Promise<{ origin: string; theirs: Set<string>; mine: Set<string>; house: Map<string, Skill> }> | undefined;
  const own = new Map<string, Promise<Record<string, SkillFile>>>();
  const rooms = new Map<string, Promise<RoomSkillSet>>();
  const environmentSkills = async () => {
    const enrolment = await readEnrolment();
    if (enrolment === null) throw new Error('this Environment is not connected; run house login');
    const catalogue = await catalogueOf();
    return {
      origin: enrolment.house,
      theirs: new Set(chosenOf((await readConfiguration()).skills, catalogue).map(({ name }) => name)),
      mine: new Set(catalogue.filter((skill) => skill.own === true).map(({ name }) => name)),
      house: houseSkills(enrolment.house),
    };
  };
  const ownOf = (name: string) => remembered(own, name, () => ownFiles(name));
  const sourceOf = async (name: string): Promise<string | undefined> => {
    const { theirs, mine, house } = await (environment ??= environmentSkills());
    if (theirs.has(name)) return ENVIRONMENT;
    if (mine.has(name)) return `own:${filesDigest(await ownOf(name))}`;
    const skill = house.get(name);
    return skill === undefined ? undefined : `house:${filesDigest(skill.files)}`;
  };
  const sources = async (names: Iterable<string>): Promise<SkillSources> => {
    const found: SkillSources = {};
    for (const name of [...new Set(names)].sort()) {
      const source = await sourceOf(name);
      if (source !== undefined) found[name] = source;
    }
    return found;
  };
  const set = async (room: string): Promise<RoomSkillSet> => {
    const listed = (await answeredSkills({ room })).sort((left, right) => (left.name < right.name ? -1 : 1));
    if (listed.length === 0) return NO_ROOM_SKILLS;
    const { origin, theirs, mine, house } = await (environment ??= environmentSkills());
    const skills: Skill[] = [];
    for (const skill of listed) {
      if (theirs.has(skill.name)) continue;
      if (mine.has(skill.name)) skills.push(ownSkill(skill.name, await ownOf(skill.name)));
      else if (skill.own) skills.push(ownSkill(skill.name, await skillFiles(skill)));
      else if (house.has(skill.name)) skills.push(house.get(skill.name)!);
    }
    const names = listed.map(({ name }) => name);
    return { listed: names, sources: await sources(names), skills, digest: digestOf(origin, skills) };
  };
  return { of: (room) => remembered(rooms, room, () => set(room)), sources };
}

function roomSkillFolders(folder: string, name: string): string[] {
  return ROOM_SKILL_FOLDERS.map((skills) => join(folder, skills, name));
}

export async function removeRoomSkills(folder: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  for (const name of names) for (const path of roomSkillFolders(folder, name)) await rm(path, { recursive: true, force: true });
  for (const skills of ROOM_SKILL_FOLDERS) {
    for (const path of [join(folder, skills), join(folder, dirname(skills))]) {
      if (!(await rmdir(path).then(() => true, () => false))) break;
    }
  }
}

export async function placeRoomSkills(
  folder: string,
  skills: readonly Skill[],
  written: readonly string[],
  record: (names: string[]) => Promise<void>,
): Promise<string[]> {
  await removeRoomSkills(folder, written);
  const placed: Skill[] = [];
  for (const skill of skills) {
    const taken = await Promise.all(roomSkillFolders(folder, skill.name).map(present));
    if (!taken.includes(true)) placed.push(skill);
  }
  const names = placed.map(({ name }) => name);
  await record(names);
  for (const { name, place } of placed) {
    for (const path of roomSkillFolders(folder, name)) {
      await mkdir(dirname(path), { recursive: true });
      await place(path);
    }
  }
  return names;
}

function held(files: Readonly<Record<string, SkillFile>>): Record<string, string | { sha256: string }> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, typeof content === 'string' ? content : { sha256: createHash('sha256').update(content).digest('hex') }]),
  );
}

function filesDigest(files: Readonly<Record<string, SkillFile>>): string {
  return createHash('sha256').update(JSON.stringify(held(files))).digest('hex');
}

function digestOf(origin: string, skills: readonly Skill[]): string {
  const kept = skills.map(({ name, files }) => [name, held(files)]);
  return createHash('sha256').update(JSON.stringify([origin, kept])).digest('hex');
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
