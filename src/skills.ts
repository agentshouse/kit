import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Bridge } from './bridge.ts';
import { KIT_RELEASE } from './clis.ts';
import { kitHome, readConfiguration, readHome, writeHome } from './home.ts';
import { refusalOf } from './refusals.ts';

interface Installed {
  version?: string;
  names: string[];
}

const HOW_WE_WORK = '/rooms/private/how-we-work.md';

const SKILL_SET = fileURLToPath(new URL('../skills/', import.meta.url));
const HOW_WE_WORK_TEXT = readFileSync(new URL('../how-we-work.md', import.meta.url), 'utf8');
const SHIPPED_HOW_WE_WORK = [
  'ae4dda60da7b174f22dc5fa9bf07fc27c25864932a74230de4f9f509ddd91f41',
  '0bdcd43e1603ba6673a3cae56d70bbf90657cbeefd124e91a47be2ca1cbd6c93',
  '4106a87ec66da6f7b2a10e74d18e6559d68d5f4fe7415dae68f5c7bdb9081968',
  'ac814a2197038f037b657bb719340395f89f319ac9fcdd386629c3fe2cec68f1',
  '29951ee394aad9979eecfed3e5dc32c2c86e2226b6a380db5dbd4f305f4d1156',
];
const RECORD = 'skill-set.json';
const WRITTEN = 'how-we-work.json';
const UNWRITABLE = new Set(['room_not_found', 'operation_denied']);
const PRESENT = new Set(['path_exists']);
const CHANGED = new Set(['base_revision_stale', 'path_absent']);
const UNREADABLE = /^(?:\S+: )?(?:path_not_found|room_not_found|operation_denied)\b/;
const FAILED = /^exit: [1-9]\d*$/;
const CUT = /^stderr: shell: output_cut (\d+) of \d+ bytes; continue with: (.+)$/;

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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function cutOf(lines: string[]): RegExpExecArray | null {
  const cut = CUT.exec(lines[0] ?? '');
  return cut !== null && Buffer.byteLength(lines.slice(1).join('\n')) === Number(cut[1]) ? cut : null;
}

export async function readHowWeWork(bridge: Bridge): Promise<string> {
  let document = '';
  for (let command: string | undefined = `cat ${HOW_WE_WORK}`; command !== undefined; ) {
    const read = await bridge.tool('shell', { command });
    const text = read.content.map((content) => content.text).join('\n');
    const lines = text.split('\n');
    if (read.isError === true || (FAILED.test(lines[0] ?? '') && lines[1]?.startsWith('stderr: '))) {
      const refusal = read.isError === true ? text : lines.slice(1).join('\n').replace(/^stderr: /gm, '');
      if (UNREADABLE.test(refusal)) return '';
      throw new Error(refusal);
    }
    const cut = cutOf(lines);
    document += lines.slice(cut === null ? 0 : 1).join('\n');
    command = cut?.[2];
  }
  return document;
}

async function currentRevision(bridge: Bridge): Promise<string> {
  const inspected = await bridge.tool('inspect', { path: HOW_WE_WORK });
  const text = inspected.content.map((content) => content.text).join('\n');
  if (inspected.isError === true) throw new Error(text);
  return (parse(text) as { revisions: { revision: string }[] }).revisions[0]!.revision;
}

async function edit(bridge: Bridge, change: Record<string, string>, kept: Set<string>): Promise<'written' | 'unwritable' | 'kept'> {
  const edited = await bridge.tool('edit', { changes: [{ ...change, path: HOW_WE_WORK, content: HOW_WE_WORK_TEXT }] });
  if (edited.isError !== true) return 'written';
  const text = edited.content.map((content) => content.text).join('\n');
  const refusal = refusalOf(text);
  if (UNWRITABLE.has(refusal?.code ?? '')) return 'unwritable';
  if (refusal?.code === 'edit_conflict' && refusal.conflicts.some((conflict) => kept.has(conflict))) return 'kept';
  throw new Error(text);
}

export async function createHowWeWork(bridge: Bridge): Promise<void> {
  if (!(await readConfiguration()).skills || (await readHome<Installed>(RECORD))?.version === undefined) return;
  const current = sha256(HOW_WE_WORK_TEXT);
  if ((await readHome<string>(WRITTEN)) === current) return;
  const created = await edit(bridge, { op: 'create' }, PRESENT);
  if (created === 'unwritable') return;
  if (created === 'kept') {
    const base = await currentRevision(bridge);
    const held = sha256(await readHowWeWork(bridge));
    if (held !== current && SHIPPED_HOW_WE_WORK.includes(held) && (await edit(bridge, { op: 'replace', base }, CHANGED)) === 'unwritable') return;
  }
  await writeHome(WRITTEN, current);
}
