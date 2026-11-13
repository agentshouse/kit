import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ADAPTER_ARCHIVES, fakeHost, PUBLISHED_VERSION, type Platform } from './host.ts';

const NEWER = '0.2.1-alpha.2';
const LINUX: Platform = { system: 'Linux', machine: 'x86_64' };
const MAC: Platform = { system: 'Darwin', machine: 'arm64' };

function downloads(node: string, version = PUBLISHED_VERSION): unknown[] {
  return [
    expect.stringMatching(new RegExp(` https://agents\\.house/kit-installer/node-v24\\.22\\.1-${node}\\.tar\\.gz$`)),
    expect.stringMatching(new RegExp(` https://agents\\.house/kit-installer/kit-${version.replaceAll('.', '\\.')}\\.tar\\.gz$`)),
    ...ADAPTER_ARCHIVES.map((name) => expect.stringContaining(` https://agents.house/kit-installer/${name}`)),
  ];
}

it.each([
  ['Linux', LINUX, 'linux-x64', '.bash_profile'],
  ['macOS', { ...MAC, shell: 'zsh' } as Platform, 'darwin-arm64', '.zprofile'],
] as const)('places Node.js and the Kit release in ~/.agents/house on %s, puts kit and house on the login path and hands over to kit connect with its two arguments', async (_name, platform, node, profile) => {
  const host = await fakeHost(platform);
  await writeFile(join(host.home, '.bash_profile'), '');

  const ran = host.run(['--house', 'https://agents.house', '--code', 'ahk_code_one'], { HOUSE_KIT_INSTALL_COMMAND: 'curl -fsSL agents.house/kit | sh' });

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect((await stat(host.kitHome)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(host.kitHome, 'kit', 'current'), 'utf8')).toBe(`${PUBLISHED_VERSION}\n`);
  await lstat(join(host.kitHome, 'kit', 'releases', PUBLISHED_VERSION, 'bin', 'node'));
  for (const name of ADAPTER_ARCHIVES) await lstat(join(host.kitHome, 'kit', 'releases', PUBLISHED_VERSION, 'adapters', name.replace(/-[0-9].*$/, '')));
  expect(host.calls('curl')).toEqual(downloads(node));
  expect(await readFile(join(host.home, profile), 'utf8')).toContain(`export PATH="${join(host.kitHome, 'bin')}:$PATH"\n`);
  expect(host.calls('kit')).toEqual(['connect --house https://agents.house --code ahk_code_one']);
  expect(host.calls('release')).toEqual([join(host.kitHome, 'kit', 'releases', PUBLISHED_VERSION)]);
  expect(host.calls('prefix')).toEqual([join(host.kitHome, 'kit')]);
  expect(host.calls('install')).toEqual(['curl -fsSL agents.house/kit | sh']);
  expect(host.calls('sudo')).toEqual([]);
  expect(host.calls('apt-get')).toEqual([]);
});

it('changes nothing it placed when it runs again with the same release, and hands over to kit connect again', async () => {
  const host = await fakeHost(LINUX);
  expect(host.run(['--house', 'https://agents.house'])).toMatchObject({ status: 0, stderr: '' });
  const placed = await stat(join(host.kitHome, 'kit', 'releases', PUBLISHED_VERSION));
  const launcher = await stat(join(host.kitHome, 'bin', 'kit'));
  const profile = await readFile(join(host.home, '.profile'), 'utf8');
  await host.forget();

  const ran = host.run(['--house', 'https://agents.house']);

  expect(ran).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(host.calls('curl')).toEqual([]);
  expect((await stat(join(host.kitHome, 'kit', 'releases', PUBLISHED_VERSION))).mtimeMs).toBe(placed.mtimeMs);
  expect((await stat(join(host.kitHome, 'bin', 'kit'))).mtimeMs).toBe(launcher.mtimeMs);
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe(profile);
  expect(host.calls('kit')).toEqual(['connect --house https://agents.house']);
});

it('places a newer release beside the one that runs on a rerun, downloading only the Kit and its adapters', async () => {
  const host = await fakeHost(LINUX);
  expect(host.run(['--house', 'https://agents.house'])).toMatchObject({ status: 0 });
  await host.publish(NEWER);
  await host.forget();

  expect(host.run(['--house', 'https://agents.house'])).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('curl')).toEqual(downloads('linux-x64', NEWER).slice(1));
  expect(await readFile(join(host.kitHome, 'kit', 'current'), 'utf8')).toBe(`${NEWER}\n`);
  await lstat(join(host.kitHome, 'kit', 'releases', PUBLISHED_VERSION));
  expect(host.calls('release')).toEqual([join(host.kitHome, 'kit', 'releases', NEWER)]);
});

it.each([
  ['a file that is not Kit\'s', async (home: string) => writeFile(join(home, 'notes.md'), 'mine\n')],
  ['nothing at all', async () => undefined],
])("stops in one line when ~/.agents/house exists and holds %s, placing nothing and connecting nothing", async (_name, fill) => {
  const host = await fakeHost(LINUX);
  await mkdir(host.kitHome, { recursive: true });
  await fill(host.kitHome);

  const ran = host.run(['--house', 'https://agents.house']);

  expect(ran).toEqual({
    status: 1,
    stdout: '',
    stderr: `kit_bootstrap_refused: ${host.kitHome} holds what is not Kit's; move it elsewhere, then run this command again\n`,
  });
  expect(host.calls('curl')).toEqual([]);
  expect(host.calls('kit')).toEqual([]);
});

it.each([
  ['a glibc older than its Node.js needs', { ...LINUX, glibc: '2.27' }, 'this Linux has glibc 2.27, and Kit needs glibc 2.28 or newer'],
  ['no glibc', { ...LINUX, glibc: false }, 'this Linux has no glibc, and Kit needs glibc 2.28 or newer'],
  ['a macOS older than its Node.js needs', { ...MAC, macos: '13.4' }, 'this Mac has macOS 13.4, and Kit needs macOS 13.5 or newer'],
  ['another architecture', { system: 'Linux', machine: 'riscv64' }, 'this Linux runs on riscv64, and Kit runs on amd64 and arm64'],
] as const)('stops on %s in one line naming the version found and the version needed, and nothing else', async (_name, platform, line) => {
  const host = await fakeHost(platform as Platform);

  const ran = host.run(['--house', 'https://agents.house']);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: `kit_bootstrap_refused: ${line}\n` });
  expect(host.calls('curl')).toEqual([]);
  await expect(lstat(host.kitHome)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('adds a missing git through apt, then places and connects Kit', async () => {
  const host = await fakeHost({ ...LINUX, absent: ['git'] });

  const ran = host.run(['--house', 'https://agents.house']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Installing git with apt; sudo may ask for your password.\n');
  expect(host.calls('apt-get')).toEqual(['update -qq', 'install -y -qq git']);
  expect(host.calls('kit')).toEqual(['connect --house https://agents.house']);
});

it('stops on a Linux without apt in one line naming what is missing, before placing anything', async () => {
  const host = await fakeHost({ ...LINUX, absent: ['git', 'apt-get'] });

  const ran = host.run(['--house', 'https://agents.house']);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: 'kit_bootstrap_refused: this host has no apt to install git; install git, then run this command again\n' });
  expect(host.calls('curl')).toEqual([]);
  expect(host.calls('kit')).toEqual([]);
});

it('warns in one line off its host contract and installs anyway', async () => {
  const host = await fakeHost({ ...LINUX, osRelease: "ID=debian\nVERSION_ID=13\nPRETTY_NAME='Debian GNU/Linux 13 (trixie)'\n" });

  const ran = host.run(['--house', 'https://agents.house']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n')[0]).toBe('Warning: Debian GNU/Linux 13 (trixie) is outdated; update to Ubuntu 26.04 LTS.');
  expect(host.calls('kit')).toEqual(['connect --house https://agents.house']);
});

const WINDOWS_COMMAND = 'irm agents.house/kit.ps1 | iex';
const WSL = { WSL_DISTRO_NAME: 'Ubuntu', HOUSE_KIT_WINDOWS_COMMAND: WINDOWS_COMMAND };
const WSL_RECOMMENDED = `Recommended: run this in Windows PowerShell instead, which keeps Kit running and starts it again after a restart:\n  ${WINDOWS_COMMAND}\nInstall here anyway? Kit will then not start by itself: it runs only while a WSL terminal is open, and not after a restart. [y/N] `;
const WSL_REFUSED = `kit_bootstrap_refused: from a WSL terminal Kit runs only while one is open, so nothing was installed; to keep it running, run this in Windows PowerShell: ${WINDOWS_COMMAND}\n`;

it('recommends the Windows command in a WSL terminal and installs and starts Kit there only once the person agrees that it then runs only while a WSL terminal is open', async () => {
  const host = await fakeHost(LINUX);

  const asked = await host.ask(['--house', 'https://agents.house', '--code', 'ahk_code_one'], WSL, 'y');

  expect(asked.status).toBe(0);
  expect(asked.shown.startsWith(WSL_RECOMMENDED)).toBe(true);
  expect(host.calls('kit')).toEqual(['connect --house https://agents.house --code ahk_code_one']);
});

it.each([
  ['declines', 'n'],
  ['answers nothing', ''],
])('installs nothing in a WSL terminal where the person %s, naming the Windows command', async (_name, answer) => {
  const host = await fakeHost(LINUX);

  const asked = await host.ask(['--house', 'https://agents.house'], WSL, answer);

  expect(asked.status).toBe(1);
  expect(asked.shown.startsWith(WSL_RECOMMENDED)).toBe(true);
  expect(host.calls('curl')).toEqual([]);
  expect(host.calls('kit')).toEqual([]);
  await expect(lstat(host.kitHome)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('installs nothing in WSL where it has no terminal to ask in, in one line naming the Windows command', async () => {
  const host = await fakeHost(LINUX);

  const ran = host.run(['--house', 'https://agents.house', '--code', 'ahk_code_one'], WSL);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: WSL_REFUSED });
  expect(host.calls('curl')).toEqual([]);
  expect(host.calls('kit')).toEqual([]);
  await expect(lstat(host.kitHome)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('asks nothing in a WSL terminal the Windows command hands its install to, and installs and starts Kit', async () => {
  const host = await fakeHost(LINUX);

  const asked = await host.ask(['--house', 'https://agents.house'], { ...WSL, HOUSE_KIT_FROM_WINDOWS: '1' }, 'n');

  expect(asked.status).toBe(0);
  expect(asked.shown).not.toContain('Install here anyway?');
  expect(host.calls('kit')).toEqual(['connect --house https://agents.house']);
});

it('passes the Kit relay through to kit connect and downloads through it', async () => {
  const relay = 'https://kit-relay.example';
  const host = await fakeHost({ ...LINUX, environment: { HOUSE_KIT_RELAY: relay } });

  expect(host.run(['--house', 'https://agents.house', '--code', 'ahk_code_one'])).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('curl').every((call) => call.includes(` ${relay}/agents.house/kit-installer/`))).toBe(true);
  expect(host.calls('relay')).toEqual([relay]);
});

it('places a release in Kit home for the update of a Kit that moved, with its launchers in bin and the path line, and connects nothing', async () => {
  const host = await fakeHost(LINUX);

  const ran = host.run(['--house', 'https://agents.house', '--place', join(host.kitHome, 'kit')]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(host.kitHome, 'kit', 'current'), 'utf8')).toBe(`${PUBLISHED_VERSION}\n`);
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toContain(join(host.kitHome, 'bin'));
  expect(host.calls('kit')).toEqual([]);
  await host.forget();
  expect(host.shell(`${join(host.kitHome, 'bin', 'kit')} resident`)).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('kit')).toEqual(['resident']);
  expect(host.calls('prefix')).toEqual([join(host.kitHome, 'kit')]);
});

it("places a release in the folder an earlier Kit's update names, beside launchers in that folder, and touches no Kit home", async () => {
  const host = await fakeHost(LINUX);
  const prefix = join(host.home, '.local', 'share', 'house-kit');

  const ran = host.run(['--house', 'https://agents.house', '--place', prefix]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(prefix, 'current'), 'utf8')).toBe(`${PUBLISHED_VERSION}\n`);
  await expect(lstat(host.kitHome)).rejects.toMatchObject({ code: 'ENOENT' });
  await host.forget();
  expect(host.shell(`${join(prefix, 'bin', 'kit')} resident`)).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('prefix')).toEqual([prefix]);
});
