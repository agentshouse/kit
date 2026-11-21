import type { DesiredAgentRoute, KitSettings } from '@agentshouse/kit-wire';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { house } from './api.ts';
import { KIT_RELEASE } from './clis.ts';
import { stagingPrefix } from './copies.ts';
import {
  earlierPrefix,
  enrolled,
  houseFolder,
  kitHome,
  readDisconnected,
  oneFolder,
  readConfiguration,
  readEnrolment,
  readHome,
  storedConfiguration,
  workspaceRoot,
  writeConfiguration,
  writeHome,
} from './home.ts';
import { askOwner, holdOwner } from './owner.ts';
import { placeSkillSet } from './skills.ts';
import { followRoot, keptName, merged, moved, present, removeFolder, within, type Placement } from './workspace.ts';

export interface SettingsChange {
  skills?: boolean;
  workspace?: string;
}

export interface Working {
  working(): boolean;
  end(): void;
  routes(): Promise<readonly DesiredAgentRoute[] | null>;
}

export type Applied = { settings: KitSettings; moved: boolean } | { refused: string; ended: boolean };

interface Move {
  from: string;
  to: string;
  kept?: string[];
}

const FOLDERS = ['agents', 'rooms'] as const;
const RECORDS = join('local-copies', 'rooms');
const EARLIER_COPIES = join('local-copies', 'rooms');
const MOVE = 'workspace-move.json';
const WORKING = 'an Agent is working; change the workspace once its turn ends';
const LOGGED_OUT = "Kit is logged out, so it cannot tell which Agents' folders their owners chose; run kit login, then change its workspace";
export const SETTINGS_USAGE = 'usage: kit settings [skills on|off | workspace <absolute path>]';
export async function enrolledRoutes(): Promise<readonly DesiredAgentRoute[] | null> {
  if (enrolled()) return (await house.act('agents/desired/list', {})).routes;
  return (await readDisconnected()) === null ? [] : null;
}

const IDLE: Working = { working: () => false, end: () => undefined, routes: enrolledRoutes };

export async function heldSettings(): Promise<KitSettings> {
  return { skills: (await readConfiguration()).skills, workspace: workspaceRoot() };
}

function records(): string {
  return join(kitHome(), RECORDS);
}

function placing(kept: readonly string[]): (source: string) => Placement {
  return (source) => {
    if (kept.includes(source)) return 'stays';
    return kept.some((folder) => within(folder, source)) ? 'opens' : 'moves';
  };
}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writable(root: string): Promise<boolean> {
  for (let at = root; ; at = dirname(at)) {
    const found = await stat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (found !== null) {
      return found.isDirectory() && access(at, constants.W_OK | constants.X_OK).then(() => true, () => false);
    }
    if (dirname(at) === at) return false;
  }
}

async function refusedRoot(from: string, to: string): Promise<string | null> {
  for (const name of FOLDERS) {
    const moving = join(from, name);
    if (within(to, moving)) return `${to} is inside ${moving}, which the change moves`;
  }
  if (!(await writable(to))) return `this account cannot write ${to}`;
  for (const name of FOLDERS) {
    const held = join(to, name);
    if ((await present(held)) === null) continue;
    return `${to} already holds ${held}`;
  }
  return null;
}

async function forward({ from, to, kept = [] }: Move): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of FOLDERS) await merged(join(from, name), join(to, name), placing(kept));
  await followRoot(records(), from, to, kept);
  await writeConfiguration({ ...(await storedConfiguration()), workspace: to });
  await rm(join(kitHome(), MOVE), { force: true });
}

async function backward({ from, to, kept = [] }: Move): Promise<void> {
  for (const name of FOLDERS) await merged(join(to, name), join(from, name), placing([]));
  await followRoot(records(), to, from, kept);
  await rm(join(kitHome(), MOVE), { force: true });
}

async function finished(move: Move): Promise<string | null> {
  try {
    await forward(move);
    return null;
  } catch (error) {
    const cause = causeOf(error);
    try {
      await backward(move);
      return cause;
    } catch (again) {
      return `${cause}; its folders could not all go back to ${move.from} (${causeOf(again)}), so Kit moves them again when it next starts`;
    }
  }
}

export async function resumeWorkspaceMove(): Promise<void> {
  const move = await readHome<Move>(MOVE);
  if (move === null) return;
  process.stderr.write(`kit: moving the workspace ${move.from} to ${move.to}, as a change that did not finish asked\n`);
  const failure = await finished(move);
  if (failure !== null) process.stderr.write(`kit: the workspace could not be moved to ${move.to}: ${failure}\n`);
}

interface Recorded {
  repository: string;
  room_handle: string;
  unfollowed?: string;
}

async function free(folder: string, from: string): Promise<boolean> {
  if ((await present(folder)) !== null) {
    const held = await stat(folder).catch(() => null);
    if (held === null || !held.isDirectory() || (await readdir(folder)).length > 0) return false;
  }
  return (await refusedRoot(from, folder)) === null;
}

async function earlierCopies(root: string): Promise<string[]> {
  const entries = await readdir(join(root, EARLIER_COPIES), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
}

async function earlierLayout(root: string): Promise<boolean> {
  if ((await earlierCopies(root)).length > 0) return true;
  return (await present(join(root, 'agents'))) !== null && (await present(join(root, 'rooms'))) === null;
}

export async function houseRoot(): Promise<string | null> {
  if (await earlierLayout(kitHome())) return kitHome();
  return (await free(houseFolder(), kitHome())) ? houseFolder() : null;
}

async function recordedCopies(): Promise<Recorded[]> {
  const names = (await readdir(records()).catch(() => [])).filter((name) => name.endsWith('.json'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(records(), name), 'utf8')) as Recorded));
}

async function laidOut(root: string): Promise<boolean> {
  const folders = await earlierCopies(root);
  const rooms = join(root, 'rooms');
  await mkdir(rooms, { recursive: true, mode: 0o700 });
  if (folders.length === 0) return false;
  const held = await recordedCopies();
  const copies = folders.map((name) => ({ name, record: held.find((copy) => copy.repository === join(root, EARLIER_COPIES, name)) }));
  const followed = (record: Recorded | undefined): record is Recorded => record !== undefined && record.unfollowed === undefined;
  for (const { name, record } of [...copies.filter((copy) => followed(copy.record)), ...copies.filter((copy) => !followed(copy.record))]) {
    const source = join(root, EARLIER_COPIES, name);
    const named = join(rooms, followed(record) ? record.room_handle : name);
    const target = followed(record) && (await present(named)) === null ? named : await keptName(named);
    await moved(source, target);
    await followRoot(records(), source, target);
  }
  const left = join(root, EARLIER_COPIES);
  for (const name of await readdir(left).catch(() => [])) {
    if (name.startsWith(stagingPrefix())) await rm(join(left, name), { recursive: true, force: true });
  }
  await removeFolder(left);
  await removeFolder(dirname(left));
  return true;
}

export async function moveIntoHouse(): Promise<string | null> {
  if (earlierPrefix() !== null) return null;
  const stored = await storedConfiguration();
  const from = stored.workspace ?? kitHome();
  if (!(await earlierLayout(from))) {
    if (stored.workspace === undefined) await writeConfiguration({ ...stored, workspace: (await houseRoot()) ?? kitHome() });
    return null;
  }
  const to = from === kitHome() && (await free(houseFolder(), from)) ? houseFolder() : from;
  const converted = await laidOut(from);
  if (to === from) {
    if (stored.workspace !== from) await writeConfiguration({ ...stored, workspace: from });
    return converted ? `Kit ${KIT_RELEASE} laid out its workspace ${from}; its supervisor starts it again` : null;
  }
  const move = { from, to };
  await writeHome(MOVE, move);
  const failure = await finished(move);
  if (failure === null) return `Kit ${KIT_RELEASE} moved its workspace to ${to}; its supervisor starts it there`;
  await writeConfiguration({ ...(await storedConfiguration()), workspace: from });
  return `the workspace could not be moved to ${to}: ${failure}; it stays at ${from} and its supervisor starts Kit again`;
}

async function changeSkills(on: boolean): Promise<void> {
  const stored = await storedConfiguration();
  await writeConfiguration({ ...stored, skills: on });
  const enrolment = await readEnrolment();
  if (enrolment !== null) await placeSkillSet(enrolment.house);
}

export async function applySettings(change: SettingsChange, kit: Working): Promise<Applied> {
  const from = workspaceRoot();
  let move: Move | null = null;
  if (change.workspace !== undefined) {
    if (earlierPrefix() !== null) {
      return { refused: `Kit runs where an earlier install placed it; its workspace changes once Kit moves into ${oneFolder()}`, ended: false };
    }
    if (!isAbsolute(change.workspace)) return { refused: `${change.workspace} is not an absolute path`, ended: false };
    const to = resolve(change.workspace);
    if (to !== from) {
      const refused = await refusedRoot(from, to);
      if (refused !== null) return { refused, ended: false };
      const routes = await kit.routes();
      if (routes === null) return { refused: LOGGED_OUT, ended: false };
      const agents = join(from, 'agents');
      const copies = join(from, 'rooms');
      const kept = routes
        .filter(({ agent_id, working_directory }) => resolve(working_directory) !== join(agents, agent_id))
        .map(({ working_directory }) => resolve(working_directory))
        .filter((folder) => folder.startsWith(`${agents}/`) || folder.startsWith(`${copies}/`));
      move = { from, to, kept };
    }
  }
  if (move !== null) {
    if (kit.working()) return { refused: WORKING, ended: false };
    kit.end();
    await writeHome(MOVE, move);
    const failure = await finished(move);
    if (failure !== null) return { refused: `the workspace could not be moved to ${move.to}: ${failure}`, ended: true };
  }
  if (change.skills !== undefined) await changeSkills(change.skills);
  return { settings: await heldSettings(), moved: move !== null };
}

function changeOf(operands: string[]): SettingsChange | null {
  const [name, value, ...rest] = operands;
  if (name === undefined) return null;
  if (rest.length === 0 && name === 'skills' && (value === 'on' || value === 'off')) return { skills: value === 'on' };
  if (rest.length === 0 && name === 'workspace' && value !== undefined) return { workspace: value };
  throw new Error(SETTINGS_USAGE);
}

async function appliedHere(change: SettingsChange): Promise<Applied> {
  const lock = await holdOwner();
  try {
    await resumeWorkspaceMove();
    await moveIntoHouse();
    return await applySettings(change, IDLE);
  } finally {
    lock.close();
  }
}

export async function kitSettings(operands: string[]): Promise<void> {
  const change = changeOf(operands);
  const answer: Applied =
    change === null ? { settings: await heldSettings(), moved: false } : ((await askOwner<Applied>('/settings', change)) ?? (await appliedHere(change)));
  if ('refused' in answer) throw new Error(answer.refused);
  process.stdout.write(`skills ${answer.settings.skills ? 'on' : 'off'}\nworkspace ${answer.settings.workspace}\n`);
}
