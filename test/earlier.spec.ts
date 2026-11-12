import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { hostKit } from './environment.ts';
import { runKit, temporaryDirectory } from './kit.ts';
import { placing, released, served, sha256 } from './release.ts';
import { ROOTED, supervision, type Supervision } from './supervision.ts';

const SERVED = '0.2.1-c000000000001';

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function serveRelease(house: House): Promise<void> {
  const release = await released(SERVED);
  const files: Record<string, Buffer> = { ...served(release), 'connect-linux.sh': await readFile(await placing(release)) };
  const manifest = {
    schemaVersion: 3,
    version: SERVED,
    hosts: { linux: 'connect-linux.sh', macos: 'connect-linux.sh', windows: 'connect-windows.ps1' },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes) }])),
  };
  house.route('GET', '/kit-installer/:name', ({ params }) => {
    if (params.name === 'bootstrap.json') return { body: manifest };
    const bytes = files[params.name!];
    return bytes === undefined ? { status: 404, body: {} } : { bytes: { type: 'application/octet-stream', content: bytes } };
  });
}

interface Earlier {
  account: string;
  folder: string;
  home: string;
  workspace: string;
}

async function earlierKit(house: House, account: string, home: string, workspace: string, placement: string): Promise<Earlier> {
  await put(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));
  await put(join(home, 'kit.json'), JSON.stringify({ skills: false }));
  await put(join(home, 'placement'), `${placement}\n`);
  await put(join(home, 'install-command'), 'curl -fsSL agents.house/kit | sh --linux\n');
  await put(join(workspace, 'agents', 'agent-1', 'notes.md'), 'kept\n');
  await put(join(workspace, 'local-copies', 'rooms', 'notes', 'plan.md'), 'plan\n');
  return { account, folder: join(account, '.agents', 'house'), home, workspace };
}

async function copyRecord(home: string, repository: string): Promise<void> {
  await put(join(home, 'local-copies', 'rooms', 'r_notes.json'), JSON.stringify({ key: 'rooms/r_notes', room_handle: 'notes', repository, moves: [{ worktree: repository, from: 'a', to: 'b' }] }));
}

async function moved(earlier: Earlier, workspace = earlier.folder): Promise<void> {
  expect(JSON.parse(await readFile(join(earlier.folder, 'credential.json'), 'utf8'))).toMatchObject({ environment: 'environment-one', credential: 'ahk_held' });
  expect(await readFile(join(earlier.folder, 'install-command'), 'utf8')).toBe('curl -fsSL agents.house/kit | sh\n');
  expect(await readFile(join(workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  expect(await readFile(join(workspace, 'local-copies', 'rooms', 'notes', 'plan.md'), 'utf8')).toBe('plan\n');
  const record = JSON.parse(await readFile(join(earlier.folder, 'local-copies', 'rooms', 'r_notes.json'), 'utf8')) as { repository: string; moves: { worktree: string }[] };
  expect(record.repository).toBe(join(workspace, 'local-copies', 'rooms', 'notes'));
  expect(record.moves[0]!.worktree).toBe(join(workspace, 'local-copies', 'rooms', 'notes'));
  await absent(earlier.home);
}

async function desktopKit(house: House, tools: Supervision, workspace?: string): Promise<Earlier & { prefix: string }> {
  const account = await temporaryDirectory();
  const home = join(account, '.house-kit');
  const chosen = workspace ?? join(account, 'AgentsHouse');
  const earlier = await earlierKit(house, account, home, chosen, 'native');
  await copyRecord(home, join(chosen, 'local-copies', 'rooms', 'notes'));
  await put(join(chosen, 'mine.txt'), 'mine\n');
  const prefix = join(account, '.local', 'share', 'house-kit');
  await put(join(prefix, 'current'), '0.2.1\n');
  await put(join(prefix, 'releases', '0.2.1', 'bin', 'kit'), '');
  for (const command of ['kit', 'house']) await put(join(account, '.local', 'bin', command), '#!/bin/sh\n');
  await put(
    join(account, '.config', 'systemd', 'user', 'house-kit.service'),
    `[Unit]\nDescription=Kit\nPartOf=graphical-session.target\n\n[Service]\nEnvironment="HOUSE_KIT_HOME=${home}"\nEnvironment="HOUSE_KIT_WORKSPACE=${chosen}"\nExecStart="${join(account, '.local', 'bin')}/kit" resident\nRestart=on-failure\n\n[Install]\nWantedBy=graphical-session.target\n`,
  );
  await tools.systemd();
  return { ...earlier, prefix };
}

function resident(earlier: Earlier, tools: Supervision, environment: Record<string, string>) {
  return runKit(['resident'], { HOME: earlier.account, ...tools.environment, ...environment }, ROOTED);
}

it("moves a Linux desktop's Kit home and its default workspace into ~/.agents/house at the move release's first start, writes the lingering user unit, removes the old prefix, launchers and unit, and ends for its supervisor", async () => {
  const house = await startHouse();
  await serveRelease(house);
  const tools = await supervision();
  const earlier = await desktopKit(house, tools);

  const kit = resident(earlier, tools, { HOUSE_KIT_PREFIX: earlier.prefix, HOUSE_KIT_HOME: earlier.home, HOUSE_KIT_WORKSPACE: earlier.workspace });

  expect(await kit.exited).toBe(1);
  expect(kit.stderr().split('\n').at(-2)).toBe(`kit: Kit 0.2.1 moved into ${earlier.folder}; its supervisor starts it there`);
  await moved(earlier);
  expect(await readFile(join(earlier.folder, 'kit', 'current'), 'utf8')).toBe(`${SERVED}\n`);
  await lstat(join(earlier.folder, 'bin', 'kit'));
  expect(await readFile(join(earlier.workspace, 'mine.txt'), 'utf8')).toBe('mine\n');
  await absent(join(earlier.workspace, 'agents'));
  await absent(earlier.prefix);
  await absent(join(earlier.account, '.local', 'bin', 'kit'));
  const unit = await readFile(join(earlier.account, '.config', 'systemd', 'user', 'house-kit.service'), 'utf8');
  expect(unit).toContain(`ExecStart="${join(earlier.folder, 'bin', 'kit')}" resident\n`);
  expect(unit).toContain('WantedBy=default.target\n');
  expect(unit).not.toContain('HOUSE_KIT');
  expect(tools.calls('loginctl')).toEqual([`enable-linger ${process.getuid!()}`]);
  expect(tools.calls('systemctl')).toEqual(['--user daemon-reload', '--user --quiet reenable house-kit.service']);
});

it('keeps a workspace its person set elsewhere where it is and names it as the workspace setting', async () => {
  const house = await startHouse();
  await serveRelease(house);
  const tools = await supervision();
  const workspace = join(await temporaryDirectory(), 'Work');
  const earlier = await desktopKit(house, tools, workspace);

  const kit = resident(earlier, tools, { HOUSE_KIT_PREFIX: earlier.prefix, HOUSE_KIT_HOME: earlier.home, HOUSE_KIT_WORKSPACE: workspace });

  expect(await kit.exited).toBe(1);
  await moved(earlier, workspace);
  expect(JSON.parse(await readFile(join(earlier.folder, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace });
});

it('stays where it was installed and moves at its next start when the release cannot be placed in its one folder', async () => {
  const house = await startHouse();
  const tools = await supervision();
  const earlier = await desktopKit(house, tools);
  house.route('GET', '/kit-installer/:name', () => ({ status: 503, body: {} }));

  const kit = resident(earlier, tools, { HOUSE_KIT_PREFIX: earlier.prefix, HOUSE_KIT_HOME: earlier.home, HOUSE_KIT_WORKSPACE: earlier.workspace });

  await until(() => kit.stderr().includes('kit: Kit stays where it was installed and moves at its next start: ') || undefined);
  await lstat(join(earlier.home, 'credential.json'));
  await lstat(earlier.prefix);
  await absent(join(earlier.folder, 'credential.json'));
});

async function rootKit(house: House, tools: Supervision, unit: boolean): Promise<Earlier> {
  const account = await temporaryDirectory();
  const home = join(account, '.house-kit');
  const workspace = join(tools.root, 'agents', 'house');
  const earlier = await earlierKit(house, account, home, workspace, 'server');
  await copyRecord(home, '/agents/house/local-copies/rooms/notes');
  await put(join(tools.root, 'opt', 'house-kit', 'current'), '0.2.1\n');
  for (const command of ['kit', 'house']) await put(join(tools.root, 'usr', 'local', 'bin', command), '#!/bin/sh\n');
  if (unit) {
    await put(
      join(tools.root, 'etc', 'systemd', 'system', 'house-kit.service'),
      `[Service]\nUser=owner\nEnvironment="HOUSE_KIT_HOME=${home}"\nWorkingDirectory=/agents/house\nExecStart=/usr/local/bin/kit resident\nRestart=on-failure\n`,
    );
    await tools.systemd();
  }
  return earlier;
}

it("moves a VPS's root Kit and /agents/house into root's ~/.agents/house, starts root's lingering user unit and stops the old system unit with its prefix and launchers removed", async () => {
  const house = await startHouse();
  await serveRelease(house);
  const tools = await supervision();
  const earlier = await rootKit(house, tools, true);

  const kit = resident(earlier, tools, { HOUSE_KIT_PREFIX: '/opt/house-kit', HOUSE_KIT_HOME: earlier.home, KIT_TEST_UID0: '1' });

  await kit.exited;
  await moved({ ...earlier, workspace: earlier.folder });
  await absent(join(tools.root, 'opt', 'house-kit'));
  await absent(join(tools.root, 'usr', 'local', 'bin', 'kit'));
  await absent(join(tools.root, 'etc', 'systemd', 'system', 'house-kit.service'));
  await absent(join(tools.root, 'agents'));
  expect(tools.calls('loginctl')).toEqual(['enable-linger 0']);
  expect(tools.calls('systemctl')).toEqual([
    'start user@0.service',
    '--user daemon-reload',
    '--user --quiet reenable house-kit.service',
    '--user --no-block start house-kit.service',
    'disable house-kit.service',
    'daemon-reload',
    '--no-block stop house-kit.service',
  ]);
  expect(tools.calls('sudo')).toEqual([]);
});

it("moves a Sandbox's root Kit into root's ~/.agents/house, writes no unit and ends for its loop", async () => {
  const house = await startHouse();
  await serveRelease(house);
  const tools = await supervision();
  const earlier = await rootKit(house, tools, false);

  const kit = resident(earlier, tools, { HOUSE_KIT_PREFIX: '/opt/house-kit', KIT_TEST_UID0: '1', HOUSE_KIT_SANDBOX: '1' });

  expect(await kit.exited).toBe(1);
  await moved({ ...earlier, workspace: earlier.folder });
  await absent(join(tools.root, 'opt', 'house-kit'));
  await absent(join(earlier.account, '.config', 'systemd'));
  expect(tools.calls('systemctl')).toEqual([]);
  expect(tools.calls('loginctl')).toEqual([]);
});

function connecting(house: House, earlier: Earlier, tools: Supervision) {
  house.route('POST', '/kit/agents/desired/list', () => ({ body: { agents: [], routes: [], transcribe: true } }));
  return runKit(['connect', '--house', house.origin], { HOME: earlier.account, ...tools.environment }, ROOTED);
}

it("takes over a container's Kit home as the same Environment when the install runs again, moving its workspace and removing the container", async () => {
  const house = await startHouse();
  const tools = await supervision();
  const account = await temporaryDirectory();
  const home = join(account, '.house-kit');
  const earlier = await earlierKit(house, account, home, join(account, 'AgentsHouse'), 'container');
  await copyRecord(home, '/agents/house/local-copies/rooms/notes');
  await put(join(home, 'kit', 'current'), '0.2.1\n');
  await writeFile(join(tools.fake, 'container'), JSON.stringify([{ Source: home, Destination: '/kit-home' }, { Source: earlier.workspace, Destination: '/agents/house' }]));
  await tools.systemd();

  const kit = connecting(house, earlier, tools);

  expect(await kit.exited).toBe(0);
  expect(kit.stdout().split('\n')[0]).toBe(`Moving the Kit installed before into ${earlier.folder}.`);
  expect(kit.stdout().split('\n').at(-2)).toBe('Kit connected for Environment environment-one.');
  await moved(earlier, earlier.folder);
  await absent(join(earlier.folder, 'kit'));
  expect(tools.calls('docker')).toContain('rm -f house-kit');
  expect(house.requests.map((request) => request.path)).not.toContain('/kit/token');
});

it("takes over a system unit's Kit run by another account than root through sudo, removing the unit with its prefix and launchers", async () => {
  const house = await startHouse();
  const tools = await supervision();
  const earlier = await rootKit(house, tools, true);

  const kit = connecting(house, earlier, tools);

  expect(await kit.exited).toBe(0);
  expect(kit.stdout()).toContain('Removing the earlier Kit service; sudo may ask for your password.\n');
  await moved({ ...earlier, workspace: earlier.folder });
  await absent(join(tools.root, 'opt', 'house-kit'));
  await absent(join(tools.root, 'etc', 'systemd', 'system', 'house-kit.service'));
  expect(tools.calls('sudo')).toEqual([
    'systemctl disable --now house-kit.service',
    `rm -f /etc/systemd/system/house-kit.service`,
    'systemctl daemon-reload',
    'rm -rf /opt/house-kit /usr/local/bin/kit /usr/local/bin/house',
    'rmdir --ignore-fail-on-non-empty /agents/house /agents',
  ]);
});

it("takes over the Kit home the Windows command copied out of its container as the same Environment, keeping its Windows workspace and following its Local copies there", async () => {
  const house = await startHouse();
  const tools = await supervision();
  const account = await temporaryDirectory();
  const home = join(account, '.house-kit-home');
  const workspace = join(account, 'mnt', 'c', 'Users', 'owner', 'AgentsHouse');
  const earlier = await earlierKit(house, account, home, workspace, 'windows');
  await put(join(home, 'workspace'), `${workspace}\n`);
  await copyRecord(home, '/agents/house/local-copies/rooms/notes');
  await tools.systemd();

  const kit = connecting(house, earlier, tools);

  expect(await kit.exited).toBe(0);
  expect(kit.stdout().split('\n')[0]).toBe(`Moving the Kit installed before into ${earlier.folder}.`);
  expect(kit.stdout().split('\n').at(-2)).toBe('Kit connected for Environment environment-one.');
  await moved(earlier, workspace);
  expect(JSON.parse(await readFile(join(earlier.folder, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace });
  await absent(join(earlier.folder, 'placement'));
  await absent(join(earlier.folder, 'workspace'));
  expect(tools.calls('docker')).toEqual([]);
  expect(house.requests.map((request) => request.path)).not.toContain('/kit/token');
});

it.each([
  ['a container Kit', 'container', 'linux'],
  ['a Windows container Kit', 'windows', 'windows'],
])('reports %s that waits for its takeover with the command to run again', async (_name, placement, reinstall) => {
  const tools = await supervision();
  const home = join(await temporaryDirectory(), 'kit-home');
  await put(join(home, 'placement'), `${placement}\n`);

  const hosted = await hostKit([{}], {
    home,
    skills: false,
    node: ROOTED,
    environment: { HOME: dirname(home), KIT_TEST_ROOT: tools.root, HOUSE_KIT_PREFIX: '/kit-home/kit', HOUSE_KIT_HOME: home },
  });

  const report = await until(() => hosted.reports[0]);
  expect(report.reinstall).toBe(reinstall);
  expect(report.agent_base).toBe('/agents/house/agents');
});
