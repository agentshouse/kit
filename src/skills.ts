import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Bridge } from './bridge.ts';
import { KIT_VERSION } from './clis.ts';
import { refusalCode } from './copies.ts';
import { kitHome, readConfiguration, readHome, writeHome } from './home.ts';

interface Installed {
  version?: string;
  names: string[];
}

export const HOW_WE_WORK = '/private/library/how-we-work.md';

const SKILL_SET = fileURLToPath(new URL('../skills/', import.meta.url));
const HOW_WE_WORK_TEXT = readFileSync(new URL('../how-we-work.md', import.meta.url), 'utf8');
const RECORD = 'skill-set.json';
const CREATED = 'how-we-work-created';
const UNWRITABLE = new Set(['room_not_found', 'operation_denied']);

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
  const names: string[] = [];
  for (const name of (await readdir(SKILL_SET)).sort()) {
    if (!(await present(join(skillsDirectory(), name))) && !(await present(join(claudeDirectory(), name)))) {
      names.push(name);
    }
  }
  await writeHome(RECORD, { names } satisfies Installed);
  await mkdir(skillsDirectory(), { recursive: true });
  await mkdir(claudeDirectory(), { recursive: true });
  const skills = await realpath(skillsDirectory());
  const claude = await realpath(claudeDirectory());
  for (const name of names) {
    await cp(join(SKILL_SET, name), join(skillsDirectory(), name), { recursive: true });
    if (claude !== skills) await symlink(relative(claude, join(skills, name)), join(claudeDirectory(), name));
  }
  await writeHome(RECORD, { version: KIT_VERSION, names } satisfies Installed);
}

export async function placeSkillSet(): Promise<void> {
  const accepted = (await readConfiguration()).skills;
  const installed = await readHome<Installed>(RECORD);
  if (accepted && installed?.version === KIT_VERSION) return;
  for (const name of installed?.names ?? []) {
    await rm(join(claudeDirectory(), name), { recursive: true, force: true });
    await rm(join(skillsDirectory(), name), { recursive: true, force: true });
  }
  if (accepted) await install();
  else await rm(join(kitHome(), RECORD), { force: true });
}

function documentPresent(refusal: string): boolean {
  const { conflicts } = parse(refusal.slice(refusal.indexOf('\n') + 1)) as { conflicts: { code: string }[] };
  return conflicts.some((conflict) => conflict.code === 'path_exists');
}

export async function createHowWeWork(bridge: Bridge): Promise<void> {
  if ((await readHome<Installed>(RECORD)) === null || (await present(join(kitHome(), CREATED)))) return;
  const created = await bridge.tool('edit', { changes: [{ op: 'create', path: HOW_WE_WORK, content: HOW_WE_WORK_TEXT }] });
  if (created.isError === true) {
    const text = created.content.map((content) => content.text).join('\n');
    const code = refusalCode(text);
    if (UNWRITABLE.has(code)) return;
    if (code !== 'edit_conflict' || !documentPresent(text)) throw new Error(text);
  }
  await writeFile(join(kitHome(), CREATED), '');
}
