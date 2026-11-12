import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { KIT_RELEASE } from './clis.ts';
import { restart } from './end.ts';
import { awaitsTakeover, desktopPrefix, earlierHome, earlierPrefix, oneFolder } from './home.ts';
import { defineSupervisor, launchAgent, linger, manage, required, systemd, userUnit } from './supervisor.ts';
import { placeServedRelease } from './update.ts';

type Kind = 'desktop' | 'server' | 'container' | 'windows';

interface Earlier {
  kind: Kind;
  home: string;
  workspace: string;
  seen: string;
  unit: boolean;
}

const SERVER_PREFIX = '/opt/house-kit';
const SERVER_BIN = '/usr/local/bin';
const SERVER_UNIT = '/etc/systemd/system/house-kit.service';
const SERVER_WORKSPACE = '/agents/house';
const CONTAINER = 'house-kit';
const CONTAINER_HOME = '/kit-home';
const CONTAINER_WORKSPACE = '/agents/house';
const WINDOWS_COPY = '.house-kit-home';
const WINDOWS_WORKSPACE = 'workspace';
const PLACEMENT = 'placement';
const RELEASES = 'kit';
const WORKSPACE_FOLDERS = ['agents', 'local-copies'];
const RECORDS = join('local-copies', 'rooms');
const COMMANDS = ['kit', 'house'];
const DROPPED_FLAGS = / --(?:linux|container)$/u;
// A Mac's LaunchAgent is reloaded by a process of its own, which ends this one within moments; a minute bounds a reload that never comes.
const RELOAD_MS = 60_000;

function root(): boolean {
  return process.getuid!() === 0;
}

function desktopWorkspace(): string {
  return join(homedir(), 'AgentsHouse');
}

function desktopBin(): string {
  return join(homedir(), '.local', 'bin');
}

function unitValue(text: string, name: string): string | undefined {
  const quoted = new RegExp(`^Environment="${name}=((?:[^"\\\\]|\\\\.)*)"$`, 'mu').exec(text)?.[1];
  return quoted?.replace(/\\(.)/gu, '$1').replaceAll('%%', '%');
}

function plistValue(text: string, name: string): string | undefined {
  const value = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`, 'u').exec(text)?.[1];
  return value?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function desktopKit(): Earlier | null {
  const darwin = process.platform === 'darwin';
  const definition = readText(darwin ? launchAgent() : userUnit()) ?? '';
  const value = (name: string) => (darwin ? plistValue(definition, name) : unitValue(definition, name));
  const named = value('HOUSE_KIT_HOME');
  if (named === undefined && !existsSync(desktopPrefix())) return null;
  const workspace = value('HOUSE_KIT_WORKSPACE') ?? desktopWorkspace();
  return { kind: 'desktop', home: named ?? join(homedir(), '.house-kit'), workspace, seen: workspace, unit: named !== undefined };
}

function serverKit(): Earlier | null {
  const unit = readText(SERVER_UNIT);
  const account = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  if (unit !== null && !new RegExp(`^User=${account}$`, 'mu').test(unit)) return null;
  if (unit === null && !(root() && existsSync(SERVER_PREFIX))) return null;
  const home = (unit === null ? undefined : unitValue(unit, 'HOUSE_KIT_HOME')) ?? join(homedir(), '.house-kit');
  return { kind: 'server', home, workspace: SERVER_WORKSPACE, seen: SERVER_WORKSPACE, unit: unit !== null };
}

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

function containerKit(): Earlier | null {
  const inspected = docker(['container', 'inspect', '--format', '{{json .Mounts}}', CONTAINER]);
  if (inspected.error !== undefined) return null;
  if (inspected.status !== 0) {
    if (readText(join(homedir(), '.house-kit', 'placement'))?.trim() !== 'container' || docker(['info']).status === 0) return null;
    throw new Error(`Kit runs in the container ${CONTAINER} on this computer and Docker does not answer; start Docker, then run this command again`);
  }
  const mounts = JSON.parse(inspected.stdout) as { Source: string; Destination: string }[];
  const source = (destination: string) => mounts.find((mount) => mount.Destination === destination)?.Source;
  const home = source(CONTAINER_HOME);
  const workspace = source(CONTAINER_WORKSPACE);
  if (home === undefined || workspace === undefined) throw new Error(`the container ${CONTAINER} mounts no Kit home or no workspace`);
  return { kind: 'container', home, workspace, seen: CONTAINER_WORKSPACE, unit: false };
}

function windowsKit(): Earlier | null {
  const home = join(homedir(), WINDOWS_COPY);
  const workspace = readText(join(home, WINDOWS_WORKSPACE))?.trim();
  if (workspace === undefined) return null;
  return { kind: 'windows', home, workspace, seen: CONTAINER_WORKSPACE, unit: false };
}

function defaulted(earlier: Earlier): boolean {
  return earlier.kind === 'server' || earlier.workspace === desktopWorkspace();
}

async function present(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listed(path: string): Promise<string[]> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const shown = await Promise.all(
    entries.map(async (entry) => {
      const at = join(entry.parentPath, entry.name);
      return `${at.slice(path.length)} ${entry.isFile() ? (await lstat(at)).size : entry.isDirectory() ? 'folder' : 'link'}`;
    }),
  );
  return shown.sort();
}

async function moved(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const copy = `${target}.moving`;
  await rm(copy, { recursive: true, force: true });
  await cp(source, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const folder = (await lstat(source)).isDirectory();
  if (folder && JSON.stringify(await listed(source)) !== JSON.stringify(await listed(copy))) {
    throw new Error(`${source} could not be copied to ${target} whole`);
  }
  await rename(copy, target);
  await rm(source, { recursive: true, force: true });
}

async function merged(from: string, to: string, skipped: readonly string[] = []): Promise<void> {
  const found = await present(from);
  if (found === null || !found.isDirectory()) return;
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (skipped.includes(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    const held = await present(target);
    if (held === null) await moved(source, target);
    else if (entry.isDirectory() && held.isDirectory()) await merged(source, target);
    else await rm(source, { recursive: true, force: true });
  }
  await rmdir(from).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
  });
}

function rewritten(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from || value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
  if (Array.isArray(value)) return value.map((item) => rewritten(item, from, to));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, held]) => [name, rewritten(held, from, to)]));
  }
  return value;
}

async function followRoot(from: string, to: string): Promise<void> {
  if (from === to) return;
  const records = join(oneFolder(), RECORDS);
  for (const name of await readdir(records).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const path = join(records, name);
    const text = await readFile(path, 'utf8');
    const next = `${JSON.stringify(rewritten(JSON.parse(text), from, to))}\n`;
    if (next.trim() === text.trim()) continue;
    await writeFile(`${path}.new`, next, { mode: 0o600 });
    await rename(`${path}.new`, path);
  }
}

async function removeFolder(path: string): Promise<void> {
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
  });
}

async function relocate(earlier: Earlier): Promise<void> {
  const folder = oneFolder();
  const copied = earlier.kind === 'windows';
  await merged(earlier.home, folder, copied ? [RELEASES, PLACEMENT, WINDOWS_WORKSPACE] : [RELEASES]);
  if (earlier.kind === 'container') await rm(join(earlier.home, RELEASES), { recursive: true, force: true });
  if (!copied) await removeFolder(earlier.home);
  const command = join(folder, 'install-command');
  const recorded = await readFile(command, 'utf8').catch(() => null);
  if (recorded !== null && DROPPED_FLAGS.test(recorded.trim())) await writeFile(command, `${recorded.trim().replace(DROPPED_FLAGS, '')}\n`);
  const workspace = defaulted(earlier) ? folder : earlier.workspace;
  if (defaulted(earlier)) {
    for (const name of WORKSPACE_FOLDERS) await merged(join(earlier.workspace, name), join(folder, name));
    if (earlier.kind !== 'server') await removeFolder(earlier.workspace);
  } else {
    const settings = join(folder, 'kit.json');
    const stored = JSON.parse((await readFile(settings, 'utf8').catch(() => null)) ?? '{}') as Record<string, unknown>;
    if (stored.workspace === undefined) {
      await writeFile(`${settings}.new`, `${JSON.stringify({ ...stored, workspace })}\n`, { mode: 0o600 });
      await rename(`${settings}.new`, settings);
    }
  }
  await followRoot(earlier.seen, workspace);
  if (copied) await rm(earlier.home, { recursive: true, force: true });
}

function elevated(args: string[], failed: string): void {
  if (root()) required(args[0]!, args.slice(1), failed);
  else required('sudo', args, failed);
}

function stopServer(earlier: Earlier, now: boolean): void {
  if (!earlier.unit) return;
  elevated(['systemctl', 'disable', ...(now ? ['--now'] : []), 'house-kit.service'], 'the earlier Kit service could not be stopped');
}

function removeServer(earlier: Earlier): void {
  if (earlier.unit) {
    elevated(['rm', '-f', SERVER_UNIT], `${SERVER_UNIT} could not be removed`);
    elevated(['systemctl', 'daemon-reload'], 'systemd could not forget the earlier Kit service');
  }
  elevated(['rm', '-rf', SERVER_PREFIX, ...COMMANDS.map((command) => join(SERVER_BIN, command))], `${SERVER_PREFIX} could not be removed`);
  const emptied = [SERVER_WORKSPACE, '/agents'].filter((path) => existsSync(path));
  if (emptied.length > 0) elevated(['rmdir', '--ignore-fail-on-non-empty', ...emptied], `${SERVER_WORKSPACE} could not be removed`);
}

async function removeDesktop(): Promise<void> {
  await rm(desktopPrefix(), { recursive: true, force: true });
  for (const command of COMMANDS) await rm(join(desktopBin(), command), { force: true });
}

function stopDesktop(): void {
  if (process.platform === 'darwin') {
    manage('launchctl', ['bootout', `gui/${process.getuid!()}/house-kit`]);
    return;
  }
  manage('systemctl', ['--user', 'disable', '--now', 'house-kit.service']);
}

export async function takeOverEarlier(): Promise<void> {
  const earlier = windowsKit() ?? containerKit() ?? serverKit() ?? desktopKit();
  if (earlier === null) return;
  process.stdout.write(`Moving the Kit installed before into ${oneFolder()}.\n`);
  if (earlier.kind === 'container') required('docker', ['rm', '-f', CONTAINER], `the container ${CONTAINER} could not be removed`);
  if (earlier.kind === 'server' && earlier.unit && !root()) process.stdout.write('Removing the earlier Kit service; sudo may ask for your password.\n');
  if (earlier.kind === 'server') stopServer(earlier, true);
  if (earlier.kind === 'desktop') stopDesktop();
  await relocate(earlier);
  if (earlier.kind === 'server') removeServer(earlier);
  if (earlier.kind === 'desktop') await removeDesktop();
}

function movable(): Earlier | null {
  if (awaitsTakeover()) return null;
  if (root()) return existsSync(SERVER_PREFIX) ? serverKit() : null;
  if (!existsSync(desktopPrefix())) return null;
  const desktop = desktopKit()!;
  if (earlierPrefix() === null) return desktop;
  return { ...desktop, home: earlierHome(), workspace: process.env.HOUSE_KIT_WORKSPACE ?? desktop.workspace };
}

function supervised(): boolean {
  return process.platform === 'darwin' || (systemd() && process.env.HOUSE_KIT_SANDBOX !== '1');
}

async function ready(): Promise<boolean> {
  try {
    if (supervised() && process.platform !== 'darwin') linger();
  } catch (error) {
    process.stderr.write(`kit: Kit stays where it was installed and moves at its next start: ${(error as Error).message}\n`);
    return false;
  }
  const failure = await placeServedRelease(join(oneFolder(), RELEASES));
  if (failure === null) return true;
  process.stderr.write(`kit: Kit stays where it was installed and moves at its next start: ${failure}\n`);
  return false;
}

async function reloadLaunchAgent(): Promise<never> {
  const target = `gui/${process.getuid!()}`;
  spawn('/bin/sh', ['-c', `launchctl bootout ${target}/house-kit; launchctl bootstrap ${target} "$0"`, launchAgent()], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  await delay(RELOAD_MS);
  restart('the LaunchAgent was not reloaded; its next start runs Kit from its one folder');
}

export async function moveEarlier(): Promise<void> {
  const earlier = movable();
  if (earlier === null) return;
  const within = earlierPrefix() !== null;
  if (within && !(await ready())) return;
  process.stderr.write(`kit: moving Kit home ${earlier.home} into ${oneFolder()}\n`);
  await relocate(earlier);
  if (within && supervised()) await defineSupervisor();
  if (within && supervised() && process.platform !== 'darwin') {
    required('systemctl', ['--user', 'daemon-reload'], 'systemd could not read the Kit service');
    required('systemctl', ['--user', '--quiet', 'reenable', 'house-kit.service'], 'the Kit service could not be enabled');
  }
  if (earlier.kind === 'server') {
    if (within && earlier.unit && supervised()) required('systemctl', ['--user', '--no-block', 'start', 'house-kit.service'], 'the Kit service could not be started');
    stopServer(earlier, false);
    removeServer(earlier);
  } else {
    await removeDesktop();
  }
  if (!within) return;
  if (process.platform === 'darwin') await reloadLaunchAgent();
  if (earlier.kind === 'server' && earlier.unit) {
    manage('systemctl', ['--no-block', 'stop', 'house-kit.service']);
    await delay(RELOAD_MS);
  }
  restart(`Kit ${KIT_RELEASE} moved into ${oneFolder()}; its supervisor starts it there`);
}
