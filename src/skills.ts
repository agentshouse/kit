import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bridge } from './bridge.ts';
import { KIT_VERSION } from './clis.ts';
import { agentBase, kitHome, readConfiguration, readHome, writeHome } from './home.ts';
import { refusalOf } from './refusals.ts';

interface Installed {
  version?: string;
  workspace?: string;
  names: string[];
}

export const HOW_WE_WORK = '/private/library/how-we-work.md';

const SKILL_SET = fileURLToPath(new URL('../skills/', import.meta.url));
const HOW_WE_WORK_TEXT = readFileSync(new URL('../how-we-work.md', import.meta.url), 'utf8');
const RECORD = 'skill-set.json';
const CREATED = 'how-we-work-created';
const UNWRITABLE = new Set(['room_not_found', 'operation_denied']);

function skillsDirectory(root: string): string {
  return join(root, '.agents', 'skills');
}

function claudeDirectory(root: string): string {
  return join(root, '.claude', 'skills');
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

async function install(workspace: string): Promise<void> {
  const names: string[] = [];
  for (const name of (await readdir(SKILL_SET)).sort()) {
    if (!(await present(join(skillsDirectory(workspace), name))) && !(await present(join(claudeDirectory(workspace), name)))) {
      names.push(name);
    }
  }
  await writeHome(RECORD, { workspace, names } satisfies Installed);
  await mkdir(skillsDirectory(workspace), { recursive: true });
  await mkdir(claudeDirectory(workspace), { recursive: true });
  const skills = await realpath(skillsDirectory(workspace));
  const claude = await realpath(claudeDirectory(workspace));
  for (const name of names) {
    await cp(join(SKILL_SET, name), join(skillsDirectory(workspace), name), { recursive: true });
    if (claude !== skills) await symlink(relative(claude, join(skills, name)), join(claudeDirectory(workspace), name));
  }
  await writeHome(RECORD, { version: KIT_VERSION, workspace, names } satisfies Installed);
}

export async function placeSkillSet(): Promise<void> {
  const accepted = (await readConfiguration()).skills;
  const installed = await readHome<Installed>(RECORD);
  const workspace = agentBase();
  if (accepted && installed?.version === KIT_VERSION && installed.workspace === workspace) return;
  const placed = installed?.workspace ?? homedir();
  for (const name of installed?.names ?? []) {
    await rm(join(claudeDirectory(placed), name), { recursive: true, force: true });
    await rm(join(skillsDirectory(placed), name), { recursive: true, force: true });
  }
  if (accepted) await install(workspace);
  else await rm(join(kitHome(), RECORD), { force: true });
}

export async function createHowWeWork(bridge: Bridge): Promise<void> {
  if ((await readHome<Installed>(RECORD)) === null || (await present(join(kitHome(), CREATED)))) return;
  const created = await bridge.tool('edit', { changes: [{ op: 'create', path: HOW_WE_WORK, content: HOW_WE_WORK_TEXT }] });
  if (created.isError === true) {
    const text = created.content.map((content) => content.text).join('\n');
    const refusal = refusalOf(text);
    if (UNWRITABLE.has(refusal?.code ?? '')) return;
    if (refusal?.code !== 'edit_conflict' || !refusal.conflicts.includes('path_exists')) throw new Error(text);
  }
  await writeFile(join(kitHome(), CREATED), '');
}
