import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fakeHost, type Host } from './host.ts';

const NATIVE = { system: 'Linux', machine: 'x86_64' } as const;

async function absent(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function enrolled(host: Host): Promise<string> {
  return (JSON.parse(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8')) as { environment: string }).environment;
}

async function placement(host: Host): Promise<string> {
  return readFile(join(host.home, '.house-kit', 'placement'), 'utf8');
}

async function keepsTheRest(host: Host): Promise<void> {
  await writeFile(join(host.home, '.house-kit', 'kit.json'), '{"skills":true}\n');
  await writeFile(join(host.home, '.house-kit', 'notes'), 'kept\n');
  await writeFile(join(host.home, 'AgentsHouse', 'notes.md'), 'kept\n');
}

async function keptTheRest(host: Host): Promise<void> {
  expect(await readFile(join(host.home, '.house-kit', 'kit.json'), 'utf8')).toBe('{"skills":true}\n');
  expect(await readFile(join(host.home, '.house-kit', 'notes'), 'utf8')).toBe('kept\n');
  expect(await readFile(join(host.home, 'AgentsHouse', 'notes.md'), 'utf8')).toBe('kept\n');
}

it('records the placement of a Kit installed natively on a server', async () => {
  const host = await fakeHost({ ...NATIVE, server: true });

  expect(host.run(['--linux'])).toMatchObject({ status: 0, stderr: '' });

  expect(await placement(host)).toBe('server\n');
});

it.each([
  ['natively on a computer', false, [], 'native'],
  ['in a container', false, ['--container'], 'container'],
  ['natively on a server', true, ['--linux'], 'server'],
])('records the placement of a Kit installed %s before its first login calls House', async (_, server, choice, placed) => {
  const host = await fakeHost({ ...NATIVE, server });

  expect(host.run(choice)).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('placement')).toEqual([placed]);
});

const INSTALL = `HOUSE_KIT_RELAY=https://relay.example sh -c 'kit=$(curl -fsSL "$0") || exit 1; eval "$kit"' https://relay.example/agents.house/kit`;

it.each([
  ['natively on a computer', false, [], ''],
  ['in a container', false, ['--container'], ' --container'],
  ['natively on a server', true, ['--linux'], ' --linux'],
])('records the command House gave it, with the placement flag, to install a Kit placed %s again', async (_, server, choice, flag) => {
  const host = await fakeHost({ ...NATIVE, server });

  expect(host.run(choice, { HOUSE_KIT_INSTALL_COMMAND: INSTALL })).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(host.home, '.house-kit', 'install-command'), 'utf8')).toBe(`${INSTALL}${flag}\n`);

  expect(host.run(choice)).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(host.home, '.house-kit', 'install-command'), 'utf8')).toBe(`${INSTALL}${flag}\n`);
});

async function native(): Promise<Host> {
  const host = await fakeHost(NATIVE);
  expect(host.run()).toMatchObject({ status: 0 });
  await keepsTheRest(host);
  await host.forget();
  return host;
}

async function contained(): Promise<Host> {
  const host = await fakeHost(NATIVE);
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await keepsTheRest(host);
  await host.forget();
  return host;
}

async function nativeUnchanged(host: Host): Promise<void> {
  expect(host.calls('docker').filter((call) => /^(run|rm|pull) /.test(call))).toEqual([]);
  expect(host.calls('systemctl').filter((call) => !call.startsWith('--user is-active '))).toEqual([]);
  expect(await readFile(join(host.home, '.config', 'systemd', 'user', 'house-kit.service'), 'utf8')).toContain('ExecStart=');
  await access(join(host.home, '.local', 'share', 'house-kit', 'release'));
  expect(await enrolled(host)).toBe('environment-one');
}

async function containerUnchanged(host: Host): Promise<void> {
  expect(host.calls('docker').filter((call) => /^(run|rm|pull) /.test(call))).toEqual([]);
  expect(host.calls('docker')).not.toContain('rm -f house-kit');
  await absent(join(host.home, '.local'));
  expect(await enrolled(host)).toBe('environment-one');
  expect(await placement(host)).toBe('container\n');
}

const ENDS = 'ends that Environment and its Agents';

it('tells a native computer run with the container choice that its Environment ends, and changes nothing without a terminal or a yes', async () => {
  const host = await native();

  const unattended = host.run(['--container']);
  expect(unattended).toEqual({
    status: 1,
    stdout: '',
    stderr: `kit_bootstrap_refused: Kit runs natively on this computer for Environment environment-one; installing it in a container ${ENDS}, so run this bootstrap in a terminal to confirm\n`,
  });
  for (const typed of ['n\n', '\n']) {
    const declined = host.terminal(['--container'], typed);
    expect(declined.status).toBe(1);
    expect(declined.stdout).toContain('Kit is already installed natively. Replace it? [y/N]');
    expect(declined.stdout).toContain('kit_bootstrap_refused: Environment environment-one was kept; nothing changed');
  }

  await nativeUnchanged(host);
  await keptTheRest(host);
});

it('tells a container computer run natively that its Environment ends, and changes nothing without a terminal or a yes', async () => {
  const host = await contained();

  expect(host.run()).toMatchObject({
    status: 1,
    stderr: `kit_bootstrap_refused: Kit runs in a container on this computer for Environment environment-one; installing it natively ${ENDS}, so run this bootstrap in a terminal to confirm\n`,
  });
  const declined = host.terminal([], 'no\n');
  expect(declined.status).toBe(1);
  expect(declined.stdout).toContain('Kit is already installed in a container. Replace it? [y/N]');

  await containerUnchanged(host);
  await keptTheRest(host);
});

it('asks nothing before Docker answers when the container it would remove cannot be reached', async () => {
  const host = await contained();
  await host.mark('docker-down');

  expect(host.terminal([], 'y\n')).toMatchObject({ status: 1 });
  expect(host.run()).toMatchObject({
    status: 1,
    stderr: expect.stringMatching(/^kit_bootstrap_refused: Kit runs in the container house-kit for Environment environment-one and Docker does not answer: .*; start Docker so that container can be removed, then rerun this bootstrap\n$/),
  });

  await host.clear('docker-down');
  await containerUnchanged(host);
});

it('replaces a native Environment with a new one in the container once the User confirms, keeping Kit home and the workspace', async () => {
  const host = await native();

  const ran = host.terminal(['--container'], 'y\n');

  expect(ran.status).toBe(0);
  expect(ran.stdout).toContain('Kit connected for Environment environment-two.');
  expect(host.calls('systemctl')).toEqual(
    expect.arrayContaining(['--user stop house-kit.service', '--user --quiet disable house-kit.service', '--user daemon-reload']),
  );
  await absent(join(host.home, '.config', 'systemd', 'user', 'house-kit.service'));
  await absent(join(host.home, '.local', 'share', 'house-kit'));
  await absent(join(host.home, '.local', 'bin', 'kit'));
  await absent(join(host.home, '.local', 'bin', 'house'));
  expect(host.calls('docker').filter((call) => call.endsWith(' login'))).toEqual([
    expect.stringContaining(' --env HOUSE_KIT_REPLACES=environment-one '),
  ]);
  expect(host.calls('docker')).toContainEqual(expect.stringMatching(/^run -d --name house-kit /));
  expect(await enrolled(host)).toBe('environment-two');
  expect(await placement(host)).toBe('container\n');
  await keptTheRest(host);
});

it('replaces a container Environment with a new native one once the User confirms, and a rerun asks nothing and keeps it', async () => {
  const host = await contained();

  const ran = host.terminal([], 'yes\n');

  expect(ran.status).toBe(0);
  expect(ran.stdout).toContain('Kit connected for Environment environment-two.');
  expect(host.calls('docker')).toContain('rm -f house-kit');
  expect(host.calls('kit')).toEqual([
    `login HOUSE_KIT_HOME=${host.home}/.house-kit HOUSE_KIT_REPLACES=environment-one`,
  ]);
  expect(host.calls('systemctl')).toContain('--user --quiet enable --now house-kit.service');
  expect(await enrolled(host)).toBe('environment-two');
  expect(await placement(host)).toBe('native\n');
  await keptTheRest(host);
  await host.forget();

  const again = host.run();

  expect(again).toMatchObject({ status: 0, stderr: '' });
  expect(again.stdout).toContain('Kit is already installed.');
  expect(host.calls('kit')).toEqual([]);
  expect(await enrolled(host)).toBe('environment-two');
});

it('asks again after a switch whose login did not finish, and returning to the old placement keeps its Environment', async () => {
  const host = await contained();
  await host.mark('login-fails');

  expect(host.terminal([], 'y\n').status).not.toBe(0);
  expect(await enrolled(host)).toBe('environment-one');
  expect(await placement(host)).toBe('container\n');
  await host.clear('login-fails');
  expect(host.run()).toMatchObject({ status: 1, stderr: expect.stringContaining(ENDS) });
  await host.forget();

  const back = host.run(['--container']);

  expect(back).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('docker').filter((call) => call.endsWith(' login'))).toEqual([]);
  await absent(join(host.home, '.local', 'share', 'house-kit'));
  expect(await enrolled(host)).toBe('environment-one');
  expect(await placement(host)).toBe('container\n');
});

it('removes a container that holds no Environment and installs natively without asking', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64' });
  await host.mark('container');

  expect(host.run()).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('docker')).toContain('rm -f house-kit');
  expect(await enrolled(host)).toBe('environment-one');
  expect(await placement(host)).toBe('native\n');
});

it('forwards nothing into the container of a computer whose Kit runs natively', async () => {
  const host = await native();

  expect(host.run(['--container', 'kit', 'login'])).toEqual({
    status: 1,
    stdout: '',
    stderr: 'kit_bootstrap_refused: Kit runs natively on this computer; run kit there directly\n',
  });
  await nativeUnchanged(host);
});

const UNIT = ['.config', 'systemd', 'user', 'house-kit.service'];

function replacing(held: string, home: string): string {
  return `kit_bootstrap_refused: Kit runs on this computer with the Kit home ${held}; installing it with the Kit home ${home} replaces that Kit, so run this bootstrap in a terminal to confirm\n`;
}

it.each([
  ['natively', []],
  ['in a container', ['--container']],
])('changes nothing of a native Kit another Kit home runs when a run %s names a new Kit home, without a terminal or a yes', async (_, choice) => {
  const host = await native();
  const held = join(host.home, '.house-kit');
  const added = { HOUSE_KIT_HOME: join(host.home, 'second-kit') };

  expect(host.run(choice, added)).toEqual({ status: 1, stdout: '', stderr: replacing(held, added.HOUSE_KIT_HOME) });
  const declined = host.terminal(choice, 'n\n', added);
  expect(declined.status).toBe(1);
  expect(declined.stdout).toContain(`Kit is already installed on this computer with the Kit home ${held}. Replace it? [y/N]`);
  expect(declined.stdout).toContain(`kit_bootstrap_refused: the Kit home ${held} was kept; nothing changed`);

  await nativeUnchanged(host);
  expect(await readFile(join(host.home, ...UNIT), 'utf8')).toContain(`Environment="HOUSE_KIT_HOME=${held}"`);
  await keptTheRest(host);
});

it('changes nothing of a container Kit another Kit home runs when a native run names a new Kit home without a terminal', async () => {
  const host = await contained();
  const added = { HOUSE_KIT_HOME: join(host.home, 'second-kit') };

  expect(host.run([], added)).toEqual({
    status: 1,
    stdout: '',
    stderr: replacing(join(host.home, '.house-kit'), added.HOUSE_KIT_HOME),
  });

  await containerUnchanged(host);
  await keptTheRest(host);
});

it('changes nothing of a server Kit another Kit home runs when a server run names a new Kit home without a terminal', async () => {
  const host = await fakeHost({ ...NATIVE, server: true });
  await host.mark('systemd');
  expect(host.run(['--linux'])).toMatchObject({ status: 0 });
  const unit = await host.serverUnit();
  await host.forget();
  const added = { HOUSE_KIT_HOME: join(host.home, 'second-kit') };

  expect(host.run(['--linux'], added)).toEqual({
    status: 1,
    stdout: '',
    stderr: replacing(join(host.home, '.house-kit'), added.HOUSE_KIT_HOME),
  });

  expect(await host.serverUnit()).toBe(unit);
  expect(host.calls('systemctl')).toEqual([]);
  expect(host.calls('kit')).toEqual([]);
});

it('replaces a native Kit another Kit home runs once the User confirms, and leaves that Kit home as it was', async () => {
  const host = await native();
  const added = { HOUSE_KIT_HOME: join(host.home, 'second-kit') };

  const ran = host.terminal([], 'y\n', added);

  expect(ran.status).toBe(0);
  expect(ran.stdout).toContain('Kit connected for Environment environment-one.');
  expect(host.calls('kit')).toEqual([`login HOUSE_KIT_HOME=${added.HOUSE_KIT_HOME}`]);
  expect(await readFile(join(host.home, ...UNIT), 'utf8')).toContain(`Environment="HOUSE_KIT_HOME=${added.HOUSE_KIT_HOME}"`);
  expect(await enrolled(host)).toBe('environment-one');
  await keptTheRest(host);
});

it('replaces a server Kit another Kit home runs once the User confirms, restarting its service on the new Kit home', async () => {
  const host = await fakeHost({ ...NATIVE, server: true });
  await host.mark('systemd');
  expect(host.run(['--linux'])).toMatchObject({ status: 0 });
  await host.forget();
  const added = { HOUSE_KIT_HOME: join(host.home, 'second-kit') };

  const ran = host.terminal(['--linux'], 'y\n', added);

  expect(ran.status).toBe(0);
  expect(ran.stdout).toContain('Kit connected for Environment environment-one.');
  expect(host.calls('systemctl')).toContain('stop house-kit.service');
  expect(host.calls('systemctl').at(-1)).toBe('--quiet enable --now house-kit.service');
  expect(await host.serverUnit()).toContain(`Environment="HOUSE_KIT_HOME=${added.HOUSE_KIT_HOME}"`);
});

it('changes nothing while Docker does not answer and the computer may run a container Kit with another Kit home', async () => {
  const host = await contained();
  await host.mark('docker-down');
  const added = { HOUSE_KIT_HOME: join(host.home, 'second-kit') };

  const ran = host.run([], added);

  expect(ran.status).toBe(1);
  expect(ran.stderr).toMatch(/^kit_bootstrap_refused: Docker does not answer: .*; start Docker so this bootstrap can see whether Kit runs in its container with another Kit home, then rerun this bootstrap\n$/u);
  await absent(join(host.home, '.local'));
  await absent(added.HOUSE_KIT_HOME);
  await host.clear('docker-down');
  await containerUnchanged(host);
});
