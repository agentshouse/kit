import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fakeHost, LOGIN_LINK, PUBLISHED_VERSION, UBUNTU_26_04, type Host, type Platform } from './host.ts';
import { temporaryHome } from './kit.ts';

const LINK_LINE = `Open this link and confirm: ${LOGIN_LINK}`;
const UID = process.getuid!();
const DEBIAN_12 = 'ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n';
const FEDORA_41 = 'ID=fedora\nVERSION_ID=41\nPRETTY_NAME="Fedora Linux 41 (Workstation Edition)"\n';
const UBUNTU_24_04 = 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n';
const UBUNTU_25_10 = 'ID=ubuntu\nVERSION_ID="25.10"\nVERSION_CODENAME=questing\nUBUNTU_CODENAME=questing\nPRETTY_NAME="Ubuntu 25.10"\n';
const ALPINE = 'ID=alpine\nVERSION_ID=3.22.2\nPRETTY_NAME="Alpine Linux v3.22"\n';

function acts(host: Host): string[] {
  return [...host.calls('systemctl'), ...host.calls('launchctl')].filter((call) => !/^((--user )?(is-(active|enabled)|show)|print) /.test(call));
}

function notices(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('Warning: '));
}

function logins(host: Host, placement: readonly string[]): string[] {
  return placement.includes('--container') ? host.calls('docker').filter((call) => / login( |$)/.test(call)) : host.calls('kit');
}

async function installed(host: Host): Promise<void> {
  const prefix = join(host.home, '.local', 'share', 'house-kit');
  expect(await readFile(join(prefix, 'release'), 'utf8')).toBe(`@agentshouse/kit@${PUBLISHED_VERSION} node@24.22.1\n`);
  for (const command of ['kit', 'house']) {
    const trusted = host.calls('ca').length;
    expect(host.command(command, ['--help'])).toMatchObject({ status: 0 });
    expect(host.calls(command).at(-1)).toMatch(/^--help /);
    expect(host.calls('ca').slice(trusted)).toEqual(['1']);
  }
  expect((await stat(join(host.home, 'AgentsHouse'))).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8'))).toMatchObject({
    environment: 'environment-one',
  });
}

function userUnit(home: string, workspace = join(home, 'AgentsHouse')): string {
  return `[Unit]
Description=Kit
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Environment="HOUSE_KIT_HOME=${home}/.house-kit"
Environment="HOUSE_KIT_WORKSPACE=${workspace}"
ExecStart="${home}/.local/bin/kit" resident
Restart=on-failure
RestartSec=5
Delegate=yes
OOMPolicy=continue

[Install]
WantedBy=graphical-session.target
`;
}

function launchAgent(home: string, workspace = join(home, 'AgentsHouse')): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>house-kit</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${home}/.local/bin/kit</string>
\t\t<string>resident</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOUSE_KIT_HOME</key>
\t\t<string>${home}/.house-kit</string>
\t\t<key>HOUSE_KIT_WORKSPACE</key>
\t\t<string>${workspace}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardErrorPath</key>
\t<string>${home}/.house-kit/kit.log</string>
</dict>
</plist>
`;
}

it("installs Kit natively beneath the home on Linux as the User's systemd service, without elevation, and enrols through kit login", async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Kit connected for Environment environment-one.\n');
  expect(host.calls('curl')).toEqual([
    expect.stringMatching(/ https:\/\/agents\.house\/kit-installer\/node-v24\.22\.1-linux-x64\.tar\.gz$/),
    expect.stringMatching(/ https:\/\/agents\.house\/kit-installer\/kit-0\.2\.1-alpha\.1\.tar\.gz$/),
  ]);
  expect(host.calls('sha256sum')).toEqual(['--check', '--check']);
  expect(host.calls('sudo')).toEqual([]);
  expect(host.calls('docker')).toEqual([
    'container inspect house-kit',
    'info --format {{.OSType}}/{{.Architecture}}',
    'container inspect house-kit',
  ]);
  expect(host.calls('kit')).toEqual([`login HOUSE_KIT_HOME=${host.home}/.house-kit`]);
  expect(ran.stdout).toContain(`${LINK_LINE}\n`);
  expect(host.calls('xdg-open')).toEqual([]);
  expect(acts(host)).toEqual(['--user daemon-reload', '--user --quiet enable --now house-kit.service']);
  expect(await readFile(join(host.home, '.config', 'systemd', 'user', 'house-kit.service'), 'utf8')).toBe(userUnit(host.home));
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe(`export PATH="${host.home}/.local/bin:$PATH"\n`);
  await installed(host);
});

it("installs Kit natively beneath the home on macOS as the User's LaunchAgent, without elevation, and enrols through kit login", async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', shell: 'zsh' });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Kit connected for Environment environment-one.\n');
  expect(notices(ran.stdout)).toEqual([]);
  expect(host.calls('curl')).toEqual([
    expect.stringMatching(/ https:\/\/agents\.house\/kit-installer\/node-v24\.22\.1-darwin-arm64\.tar\.gz$/),
    expect.stringMatching(/ https:\/\/agents\.house\/kit-installer\/kit-0\.2\.1-alpha\.1\.tar\.gz$/),
  ]);
  expect(host.calls('shasum')).toEqual(['-a 256 --check', '-a 256 --check']);
  expect(host.calls('sudo')).toEqual([]);
  expect(ran.stdout).toContain(`${LINK_LINE}\n`);
  expect(host.calls('open')).toEqual([]);
  expect(acts(host)).toEqual([`enable gui/${UID}/house-kit`, `bootstrap gui/${UID} ${host.home}/Library/LaunchAgents/house-kit.plist`]);
  expect(await readFile(join(host.home, 'Library', 'LaunchAgents', 'house-kit.plist'), 'utf8')).toBe(launchAgent(host.home));
  expect(await readFile(join(host.home, '.zprofile'), 'utf8')).toBe(`export PATH="${host.home}/.local/bin:$PATH"\n`);
  await installed(host);
});

it.each([
  ['Linux', { system: 'Linux', machine: 'x86_64' }],
  ['macOS', { system: 'Darwin', machine: 'arm64' }],
] as const)(
  'keeps Kit home, the workspace and the enrolment on a %s rerun, and starts no second service and adds no second path line',
  async (_name, platform) => {
    const host = await fakeHost(platform);
    await writeFile(join(host.home, '.profile'), '# the owner\'s profile');
    expect(host.run()).toMatchObject({ status: 0 });
    await writeFile(join(host.home, 'AgentsHouse', 'notes.md'), 'kept\n');
    await writeFile(join(host.home, '.house-kit', 'kit.json'), '{"skills":true}\n');
    const credential = await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8');
    await host.forget();

    const ran = host.run();

    expect(ran).toMatchObject({ status: 0, stderr: '' });
    expect(ran.stdout).toContain('Kit is already installed.\n');
    expect(host.calls('curl')).toEqual([]);
    expect(host.calls('kit')).toEqual([]);
    expect(acts(host)).toEqual([]);
    expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe(
      `# the owner's profile\nexport PATH="${host.home}/.local/bin:$PATH"\n`,
    );
    expect(await readFile(join(host.home, 'AgentsHouse', 'notes.md'), 'utf8')).toBe('kept\n');
    expect(await readFile(join(host.home, '.house-kit', 'kit.json'), 'utf8')).toBe('{"skills":true}\n');
    expect(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8')).toBe(credential);
  },
);

it.each([
  ['Linux', { system: 'Linux', machine: 'x86_64' }, ['--user start house-kit.service']],
  ['macOS', { system: 'Darwin', machine: 'arm64' }, [`kickstart gui/${UID}/house-kit`]],
] as const)('starts the %s service it finds loaded but not running when a rerun finds nothing else to change', async (_name, platform, start) => {
  const host = await fakeHost(platform);
  expect(host.run()).toMatchObject({ status: 0 });
  await host.clear('active');
  await host.forget();

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Kit restarted for Environment environment-one.\n');
  expect(host.calls('node')).toContain('service-main.js');
  expect(acts(host)).toEqual(start);
});

it('stops a running Linux service that is no longer enabled before it replaces the Kit release', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  await host.clear('enabled');
  await writeFile(join(host.home, '.local', 'share', 'house-kit', 'release'), '@agentshouse/kit@0.2.1-alpha.0 node@24.22.1\n');
  await host.forget();

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(acts(host)).toEqual(['--user stop house-kit.service', '--user --quiet enable --now house-kit.service']);
});

it.each([
  ['Linux', { system: 'Linux', machine: 'x86_64' }, ['--user daemon-reload', '--user restart house-kit.service']],
  ['macOS', { system: 'Darwin', machine: 'arm64' }, [`bootout gui/${UID}/house-kit`, `enable gui/${UID}/house-kit`, expect.stringMatching(/^bootstrap /)]],
] as const)('restarts the %s service in place when a rerun moves the workspace root', async (_name, platform, restart) => {
  const host = await fakeHost(platform);
  expect(host.run()).toMatchObject({ status: 0 });
  await host.forget();

  const ran = host.run(['--workspace', join(host.home, 'Agents')]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Kit restarted for Environment environment-one.\n');
  expect(acts(host)).toEqual(restart);
  const definition =
    platform.system === 'Linux'
      ? await readFile(join(host.home, '.config', 'systemd', 'user', 'house-kit.service'), 'utf8')
      : await readFile(join(host.home, 'Library', 'LaunchAgents', 'house-kit.plist'), 'utf8');
  expect(definition).toBe(
    platform.system === 'Linux' ? userUnit(host.home, join(host.home, 'Agents')) : launchAgent(host.home, join(host.home, 'Agents')),
  );
});

it.each([
  ['LaunchAgent', { system: 'Darwin', machine: 'arm64' }, 'Library/LaunchAgents/house-kit.plist', '<string>~/R&amp;D &lt;50%&gt;</string>'],
  ['systemd unit', { system: 'Linux', machine: 'x86_64' }, '.config/systemd/user/house-kit.service', 'Environment="HOUSE_KIT_WORKSPACE=~/R&D <50%%>"'],
] as const)('writes a workspace path with markup or specifier characters into the %s as text', async (_name, platform, definition, line) => {
  const host = await fakeHost(platform);

  expect(host.run(['--workspace', join(host.home, 'R&D <50%>')])).toMatchObject({ status: 0, stderr: '' });

  expect((await readFile(join(host.home, definition), 'utf8')).split('\n')).toContain(
    line.replace('~', host.home).replace(/^/, platform.system === 'Darwin' ? '\t\t' : ''),
  );
});

it.each([
  ['LaunchAgent', { system: 'Darwin', machine: 'arm64' }, 'Library/LaunchAgents/house-kit.plist', '<string>~/R&amp;D &lt;50%&gt;</string>'],
  ['systemd unit', { system: 'Linux', machine: 'x86_64' }, '.config/systemd/user/house-kit.service', 'Environment="HOUSE_KIT_HOME=~/R&D <50%%>"'],
] as const)('names the Kit home HOUSE_KIT_HOME chose in the %s, so the service reads the credential the login stored there', async (_name, platform, definition, line) => {
  const root = await temporaryHome();
  const kitHome = join(root, 'R&D <50%>');
  const host = await fakeHost({ ...platform, environment: { HOUSE_KIT_HOME: kitHome } });

  expect(host.run()).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('kit')).toEqual([`login HOUSE_KIT_HOME=${kitHome}`]);
  expect((await readFile(join(host.home, definition), 'utf8')).split('\n')).toContain(
    line.replace('~', root).replace(/^/, platform.system === 'Darwin' ? '\t\t' : ''),
  );
});

it.each([
  ['LaunchAgent', { system: 'Darwin', machine: 'arm64' }, 'Library/LaunchAgents/house-kit.plist'],
  ['systemd unit', { system: 'Linux', machine: 'x86_64' }, '.config/systemd/user/house-kit.service'],
] as const)('keeps the workspace root its %s names when a rerun names none', async (_name, platform, definition) => {
  const host = await fakeHost(platform);
  expect(host.run(['--workspace', join(host.home, 'R&D <50%> "a\\b"')])).toMatchObject({ status: 0, stderr: '' });
  const written = await readFile(join(host.home, definition), 'utf8');

  expect(host.run()).toMatchObject({ status: 0, stderr: '' });

  expect(await readFile(join(host.home, definition), 'utf8')).toBe(written);
  await expect(access(join(host.home, 'AgentsHouse'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('adds the path line to the login file bash reads when there is a .bash_login and no .bash_profile', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  await writeFile(join(host.home, '.bash_login'), '');
  await writeFile(join(host.home, '.profile'), '');

  expect(host.run()).toMatchObject({ status: 0 });

  expect(await readFile(join(host.home, '.bash_login'), 'utf8')).toBe(`export PATH="${host.home}/.local/bin:$PATH"\n`);
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe('');
});

it('adds the path line to the .zprofile in ZDOTDIR when zsh has one', async () => {
  const zdotdir = await temporaryHome();
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', shell: 'zsh', environment: { ZDOTDIR: zdotdir } });

  expect(host.run()).toMatchObject({ status: 0 });
  expect(host.run()).toMatchObject({ status: 0 });

  expect(await readFile(join(zdotdir, '.zprofile'), 'utf8')).toBe(`export PATH="${host.home}/.local/bin:$PATH"\n`);
  await expect(access(join(host.home, '.zprofile'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('adds the path line to the .zprofile in the ZDOTDIR that .zshenv sets without exporting it', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', shell: 'zsh' });
  await writeFile(join(host.home, '.zshenv'), 'ZDOTDIR="$HOME/.config/zsh"\n');

  expect(host.run()).toMatchObject({ status: 0 });

  expect(await readFile(join(host.home, '.config', 'zsh', '.zprofile'), 'utf8')).toBe(`export PATH="${host.home}/.local/bin:$PATH"\n`);
  await expect(access(join(host.home, '.zprofile'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it("adds the path line to fish's config.fish when fish is the login shell", async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', shell: '/usr/bin/fish' });

  expect(host.run()).toMatchObject({ status: 0 });
  expect(host.run()).toMatchObject({ status: 0 });

  expect(await readFile(join(host.home, '.config', 'fish', 'config.fish'), 'utf8')).toBe(`set -gx PATH "${host.home}/.local/bin" $PATH\n`);
  await expect(access(join(host.home, '.profile'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('restarts the running service when a rerun changes the Kit configuration', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  await host.forget();
  await host.mark('changed');

  const ran = host.run(['--no-skills']);

  expect(ran.stdout).toContain('Kit restarted for Environment environment-one.\n');
  expect(acts(host)).toEqual(['--user restart house-kit.service']);
});

it.each([
  ['Linux', { system: 'Linux', machine: 'x86_64' }],
  ['macOS', { system: 'Darwin', machine: 'arm64' }],
] as const)('lists and updates no CLI, asks nothing about one and leaves Kit home no restart marker when the native placement on %s runs again, and refuses --update-clis as unknown', async (_name, platform) => {
  const host = await fakeHost(platform);
  expect(host.run()).toMatchObject({ status: 0 });
  await writeFile(join(host.home, '.local', 'bin', 'codex'), '#!/bin/sh\nprintf \'codex %s\\n\' "$*" >> "$FAKE/log"\n', { mode: 0o755 });
  await host.forget();

  const ran = host.terminal([], '\n');

  expect(ran).toMatchObject({ status: 0, stdout: expect.stringContaining('Kit is already installed.\n') });
  expect(ran.stdout).not.toMatch(/Update it\?|Updating /);
  expect(host.calls('node')).not.toContain('clis-main.js');
  expect(host.calls('codex')).toEqual([]);
  expect(acts(host)).toEqual([]);
  await expect(access(join(host.home, '.house-kit', 'restart'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(host.run(['--update-clis'])).toMatchObject({ status: 1, stderr: 'kit_bootstrap_refused: unknown argument --update-clis\n' });
});

const OFF_CONTRACT = [
  ['Debian', DEBIAN_12, 'Debian GNU/Linux 12 (bookworm)'],
  ['Fedora', FEDORA_41, 'Fedora Linux 41 (Workstation Edition)'],
  ['an older Ubuntu', UBUNTU_24_04, 'Ubuntu 24.04.3 LTS'],
] as const;

const NATIVE_ROUTES = [
  ['the native desktop placement', false, []],
  ['native-host mode', true, ['--linux']],
] as const;

it.each(OFF_CONTRACT.flatMap(([host, osRelease, found]) => NATIVE_ROUTES.map(([route, server, placement]) => [host, route, osRelease, found, server, placement] as const)))(
  'warns in one line on %s in %s naming the host and the contract, then installs Kit and enrols',
  async (_host, _route, osRelease, found, server, placement) => {
    const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server, osRelease, systemd: true });

    const ran = host.run([...placement]);

    expect(ran).toMatchObject({ status: 0, stderr: '' });
    expect(notices(ran.stdout)).toEqual([`Warning: ${found} is outdated; update to Ubuntu 26.04 LTS.`]);
    expect(ran.stdout).toContain('Kit connected for Environment environment-one.\n');
    expect(host.calls('curl')).toEqual([expect.stringContaining('/kit-installer/node-v24.22.1-linux-x64.tar.gz'), expect.stringContaining('/kit-installer/kit-')]);
    expect(host.calls('kit')).toEqual([expect.stringMatching(/^login /)]);
  },
);

it.each(NATIVE_ROUTES)('says nothing about the system on Ubuntu 26.04 LTS on amd64 in %s', async (_route, server, placement) => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server, osRelease: UBUNTU_26_04, systemd: true });

  const ran = host.run([...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(notices(ran.stdout)).toEqual([]);
});

it('warns in one line on Ubuntu 26.04 LTS on arm64, naming both architectures, and installs the arm64 Node.js', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'aarch64' });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(notices(ran.stdout)).toEqual(['Warning: Ubuntu 26.04 LTS on arm64 is outdated; update to Ubuntu 26.04 LTS on amd64.']);
  expect(host.calls('curl')).toEqual([expect.stringContaining('/kit-installer/node-v24.22.1-linux-arm64.tar.gz'), expect.stringContaining('/kit-installer/kit-')]);
  await installed(host);
});

it.each([
  ['an older macOS on Apple silicon', { macos: '26.7.1', appleSilicon: true }, 'Warning: macOS 26.7.1 is outdated; update to macOS 27.', 'darwin-arm64'],
  ['an Intel Mac', { appleSilicon: false }, 'Warning: macOS 27.0.1 on an Intel chip is outdated; update to macOS 27 on Apple silicon.', 'darwin-x64'],
  ['an older Intel Mac', { macos: '15.7.1', appleSilicon: false }, 'Warning: macOS 15.7.1 on an Intel chip is outdated; update to macOS 27 on Apple silicon.', 'darwin-x64'],
] as const)('warns in one line on %s and installs', async (_name, mac, notice, node) => {
  const host = await fakeHost({ system: 'Darwin', machine: mac.appleSilicon ? 'arm64' : 'x86_64', ...mac });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(notices(ran.stdout)).toEqual([notice]);
  expect(host.calls('curl')).toEqual([expect.stringContaining(`/kit-installer/node-v24.22.1-${node}.tar.gz`), expect.stringContaining('/kit-installer/kit-')]);
  await installed(host);
});

it('says nothing about the system on the supported macOS release on Apple silicon', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', appleSilicon: true });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).not.toMatch(/Warning|macOS|Apple silicon/);
});

it.each([
  ['the native desktop placement', false, []],
  ['the container', false, ['--container']],
  ['native-host mode', true, ['--linux']],
] as const)('refuses a ppc64le host in %s, naming its architecture, before touching the host', async (_name, server, placement) => {
  const host = await fakeHost({ system: 'Linux', machine: 'ppc64le', server });

  expect(host.run([...placement])).toEqual({ status: 1, stdout: '', stderr: 'kit_bootstrap_refused: unsupported Linux architecture ppc64le\n' });
  expect([...host.calls('sudo'), ...host.calls('docker'), ...host.calls('curl')]).toEqual([]);
  await expect(access(join(host.home, '.local'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['the native desktop placement', false, [], 'rerun this bootstrap with --container to run Kit in a container'],
  ['native-host mode', true, ['--linux'], 'rerun this bootstrap with --container in place of --linux to run Kit in a container'],
] as const)('refuses %s on a Linux without glibc, naming the container, before touching the host', async (_name, server, placement, rerun) => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server, osRelease: ALPINE, glibc: false });

  expect(host.run([...placement])).toEqual({
    status: 1,
    stdout: '',
    stderr: `kit_bootstrap_refused: this Linux has no glibc, so Kit cannot run natively on it; ${rerun}\n`,
  });
  expect([...host.calls('sudo'), ...host.calls('docker'), ...host.calls('curl'), ...host.calls('kit')]).toEqual([]);
});

it('installs the container on a Linux without glibc', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', osRelease: ALPINE, glibc: false });

  const ran = host.run(['--container']);

  expect(ran).toEqual({
    status: 0,
    stdout: `Warning: Alpine Linux v3.22 is outdated; update to Ubuntu 26.04 LTS.\n${LINK_LINE}\nKit connected for Environment environment-one.\n`,
    stderr: '',
  });
  expect(host.calls('docker').filter((call) => call.startsWith('run -d '))).toHaveLength(1);
});

it.each([
  ['Debian', { system: 'Linux', machine: 'x86_64', osRelease: DEBIAN_12 }, 'Warning: Debian GNU/Linux 12 (bookworm) is outdated; update to Ubuntu 26.04 LTS.'],
  ['an Intel Mac', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }, 'Warning: macOS 27.0.1 on an Intel chip is outdated; update to macOS 27 on Apple silicon.'],
] as const)('warns in one line on %s when it installs the container, and not before a command forwarded into it', async (_name, platform, notice) => {
  const host = await fakeHost(platform);

  const ran = host.run(['--container']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(notices(ran.stdout)).toEqual([notice]);
  const forwarded = host.run(['--container', 'kit', 'logout', '--help']);
  expect(forwarded).toMatchObject({ status: 0, stderr: '' });
  expect(notices(forwarded.stdout)).toEqual([]);
});

it.each(NATIVE_ROUTES)(
  'installs Kit and enrols the Environment on a Linux without systemd in %s, starts nothing and names kit resident',
  async (_name, server, placement) => {
    const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server, systemd: false });

    const ran = host.run([...placement]);

    expect(ran).toMatchObject({ status: 0, stderr: '' });
    expect(host.calls('kit')).toEqual([expect.stringMatching(/^login /)]);
    expect(JSON.parse(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8'))).toMatchObject({ environment: 'environment-one' });
    expect(acts(host)).toEqual([]);
    const lines = ran.stdout.split('\n');
    expect(lines.at(-1)).toBe('');
    const named = /^Kit (\S+) is installed for Environment environment-one, but no systemd runs on this host to start it; run (.+ resident) under your own service manager, restarting it whenever it ends with a failure\.$/.exec(lines.at(-2)!);
    expect(named?.[1]).toBe(PUBLISHED_VERSION);
    await expect(access(join(host.home, '.config', 'systemd', 'user', 'house-kit.service'))).rejects.toMatchObject({ code: 'ENOENT' });
    await host.forget();
    expect(host.shell(named![2]!)).toMatchObject({ status: 0, stderr: '' });
    const workspace = server ? '\\S+/server/workspace' : `${host.home}/AgentsHouse`;
    expect(host.calls('kit')).toEqual([expect.stringMatching(new RegExp(`^resident HOUSE_KIT_HOME=${host.home}/\\.house-kit HOUSE_KIT_WORKSPACE=${workspace}$`))]);
  },
);

it('installs a missing git through apt in native-host mode, then installs Kit', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true, absent: ['git'] });

  const ran = host.run(['--linux']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Installing git with apt; sudo may ask for your password.\n');
  expect(host.calls('apt-get')).toEqual(['update -qq', 'install -y -qq git']);
  expect(host.calls('kit')).toEqual([expect.stringMatching(/^login /)]);
});

it('stops native-host mode on a host without apt, naming the missing git, before installing Kit', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true, osRelease: FEDORA_41, absent: ['git', 'apt-get'] });

  const ran = host.run(['--linux']);

  expect(ran).toMatchObject({ status: 1, stderr: 'kit_bootstrap_refused: this host has no apt to install git; install git, then rerun this bootstrap\n' });
  expect([...host.calls('curl'), ...host.calls('kit')]).toEqual([]);
});

it.each([
  ['Debian', DEBIAN_12, 'debian', 'bookworm', 'Debian GNU/Linux 12 (bookworm)'],
  ['a non-LTS Ubuntu release', UBUNTU_25_10, 'ubuntu', 'questing', 'Ubuntu 25.10'],
] as const)("installs Docker Engine from Docker's apt repository on %s, then the container", async (_name, osRelease, distribution, suite, described) => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', osRelease });
  await host.mark('docker-down');

  const ran = host.run(['--container']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain(`Installing Docker Engine from Docker's apt repository for ${described}; sudo may ask for your password.\n`);
  expect(host.calls('sudo')).toEqual(
    expect.arrayContaining([
      `curl -fsSL https://download.docker.com/linux/${distribution}/gpg -o /etc/apt/keyrings/docker.asc`,
      'apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    ]),
  );
  expect(host.calls('tee')).toEqual([
    `Types: deb URIs: https://download.docker.com/linux/${distribution} Suites: ${suite} Components: stable Architectures: amd64 Signed-By: /etc/apt/keyrings/docker.asc `,
  ]);
  expect(ran.stdout).toContain('Kit connected for Environment environment-one.\n');
  expect(host.calls('docker').filter((call) => call.startsWith('run -d '))).toHaveLength(1);
});

it('stops the container route on another distribution without Docker Engine, naming what it needs', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', osRelease: FEDORA_41, absent: ['docker'] });

  expect(host.run(['--container'])).toEqual({
    status: 1,
    stdout: 'Warning: Fedora Linux 41 (Workstation Edition) is outdated; update to Ubuntu 26.04 LTS.\n',
    stderr: 'kit_bootstrap_refused: Docker Engine is not installed on Fedora Linux 41 (Workstation Edition); install a working Docker Engine, then rerun this bootstrap\n',
  });
  expect([...host.calls('sudo'), ...host.calls('apt-get')]).toEqual([]);
});

it('says the Kit updated when a rerun installs a newer release', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  await writeFile(join(host.home, '.local', 'share', 'house-kit', 'release'), '@agentshouse/kit@0.2.1-alpha.0 node@24.22.1\n');

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe('Kit updated.');
});

const HOUSE = ['--house', 'https://agents.house'];

async function heldByAnotherAccount(): Promise<Host> {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  await writeFile(
    join(host.home, '.house-kit', 'credential.json'),
    '{"house":"https://dev.agents.house","environment":"environment-one","credential":"ahk_one"}',
  );
  await writeFile(join(host.home, '.house-kit', 'own-agent.json'), '{"user":"user-one"}\n');
  await writeFile(join(host.home, 'AgentsHouse', 'notes.md'), 'kept\n');
  await host.forget();
  return host;
}

it('refuses a native Kit for a second Building, naming the container, and changes nothing of the Kit serving the first', async () => {
  const host = await heldByAnotherAccount();

  for (const ran of [host.terminal([...HOUSE, '--code', 'ahk_code_one'], 'y\n'), host.run(HOUSE)]) {
    expect(ran.status).toBe(1);
    expect(`${ran.stdout}${ran.stderr}`).toContain(
      'kit_bootstrap_refused: Kit on this computer serves https://dev.agents.house, and a computer runs one native Kit; install Kit for https://agents.house in a container: add --container',
    );
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('Replace it?');
  }

  expect(host.calls('kit')).toEqual([]);
  expect(host.calls('systemctl')).toEqual([]);
  expect(await readFile(join(host.home, '.house-kit', 'own-agent.json'), 'utf8')).toBe('{"user":"user-one"}\n');
});

it("runs a second Building's Kit in a container of its own beside the native Kit serving the first, with its own Kit home and workspace, and forwards kit and house into it", async () => {
  const host = await heldByAnotherAccount();
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const mounts = `--mount type=bind,"src=${host.home}/.house-kit-agents.house",dst=/kit-home --mount type=bind,"src=${host.home}/AgentsHouse-agents.house",dst=/agents/house`;

  const ran = host.run([...HOUSE, '--container', '--code', 'ahk_code_one']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).not.toContain('Replace it?');
  expect(host.calls('docker').filter((call) => /^(run -d|rm) /.test(call))).toEqual([
    `run -d --name house-kit-agents.house --restart on-failure --env NODE_EXTRA_CA_CERTS=/kit-home/certificates.pem --user ${uid} ${mounts} --label agentshouse.house=https://agents.house agents.house/kit@sha256:${'a'.repeat(64)} resident`,
  ]);
  expect(JSON.parse(await readFile(join(host.home, '.house-kit-agents.house', 'credential.json'), 'utf8'))).toMatchObject({ environment: 'environment-one' });
  expect(JSON.parse(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8'))).toMatchObject({ house: 'https://dev.agents.house' });
  expect(await readFile(join(host.home, '.house-kit', 'own-agent.json'), 'utf8')).toBe('{"user":"user-one"}\n');
  await access(join(host.home, '.local', 'share', 'house-kit', 'release'));
  expect(host.calls('systemctl')).toEqual([]);
  await host.forget();

  expect(host.run([...HOUSE, '--container', 'house', 'list_rooms'])).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('docker').filter((call) => call.startsWith('exec '))).toEqual([
    expect.stringMatching(/^exec -i --workdir \/agents\/house house-kit-agents\.house house list_rooms$/),
  ]);
});

it('refuses a stored credential House refuses, in a terminal too, and offers no replacement', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  await host.mark('refused');
  await host.forget();

  const ran = host.terminal(HOUSE, 'y\n');

  expect(ran.status).toBe(1);
  expect(ran.stdout).not.toContain('Replace it?');
  expect(ran.stdout).toContain(
    `kit_bootstrap_refused: House refuses the stored Kit credential of Environment environment-one; to reconnect it, run ${host.home}/.local/bin/kit login`,
  );
  expect(host.calls('kit')).toEqual([]);
});

it("installs the container from the Building's registry only with the container choice, handing it the computer's certificate authorities", async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  const image = `agents.house/kit@sha256:${'a'.repeat(64)}`;
  const authorities = '--env NODE_EXTRA_CA_CERTS=/kit-home/certificates.pem';
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const mounts = `--mount type=bind,"src=${host.home}/.house-kit",dst=/kit-home --mount type=bind,"src=${host.home}/AgentsHouse",dst=/agents/house`;

  const ran = host.run(['--container']);

  expect(ran).toEqual({
    status: 0,
    stdout: `${LINK_LINE}\nKit connected for Environment environment-one.\n`,
    stderr: '',
  });
  expect(host.calls('docker')).toEqual([
    'info --format {{.OSType}}/{{.Architecture}}',
    'container inspect house-kit',
    'container inspect house-kit',
    `pull --quiet --platform linux/amd64 ${image}`,
    `run --entrypoint node --rm --network host ${authorities} --user ${uid} ${mounts} ${image} /usr/local/lib/node_modules/@agentshouse/kit/dist/configure-main.js`,
    `run --rm --network host ${authorities} --user ${uid} ${mounts} ${image} login`,
    `run -d --name house-kit --restart on-failure ${authorities} --user ${uid} ${mounts} --label agentshouse.house=https://agents.house ${image} resident`,
  ]);
  expect(await readFile(join(host.home, '.house-kit', 'certificates.pem'), 'utf8')).toContain("the computer's own authority");
  expect(host.calls('xdg-open')).toEqual([LOGIN_LINK]);
  expect([...host.calls('curl'), ...host.calls('systemctl'), ...host.calls('sudo')]).toEqual([]);
  await expect(access(join(host.home, '.local'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('installs the container on macOS through Docker Desktop, publishing no port, and opens the printed link in the host browser', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'x86_64', appleSilicon: false });
  const image = `agents.house/kit@sha256:${'a'.repeat(64)}`;
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const mounts = `--mount type=bind,"src=${host.home}/.house-kit",dst=/kit-home --mount type=bind,"src=${host.home}/AgentsHouse",dst=/agents/house`;

  const ran = host.run(['--container']);

  expect(ran).toEqual({
    status: 0,
    stdout: `Warning: macOS 27.0.1 on an Intel chip is outdated; update to macOS 27 on Apple silicon.\n${LINK_LINE}\nKit connected for Environment environment-one.\n`,
    stderr: '',
  });
  expect(host.calls('docker').filter((call) => call.endsWith(' login'))).toEqual([
    `run --rm --env NODE_EXTRA_CA_CERTS=/kit-home/certificates.pem --user ${uid} ${mounts} ${image} login`,
  ]);
  expect(host.calls('docker').join('\n')).not.toMatch(/--publish|HOUSE_KIT_LOGIN_PORT/);
  expect(host.calls('open')).toEqual([LOGIN_LINK]);
  expect(host.calls('security')).toEqual(['find-certificate -a -p /Library/Keychains/System.keychain']);
  expect(await readFile(join(host.home, '.house-kit', 'certificates.pem'), 'utf8')).toBe(
    '-----BEGIN CERTIFICATE-----\nthe keychain authority\n-----END CERTIFICATE-----\n',
  );
});

it.each([
  ['has no browser opener', (host: Host) => host.uninstall('xdg-open')],
  ['has a browser opener that fails', (host: Host) => host.mark('opener-fails')],
])('leaves the printed link to the User and connects when the container host %s', async (_name, prepare) => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  await prepare(host);

  const ran = host.run(['--container']);

  expect(ran).toEqual({ status: 0, stdout: `${LINK_LINE}\nKit connected for Environment environment-one.\n`, stderr: '' });
  expect(JSON.parse(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8'))).toMatchObject({
    environment: 'environment-one',
  });
});

it('opens the link of a kit login forwarded into the container in the host browser', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.forget();

  const ran = host.run(['--container', 'kit', 'login']);

  expect(ran).toEqual({ status: 0, stdout: `${LINK_LINE}\n`, stderr: '' });
  expect(host.calls('docker').filter((call) => call.endsWith(' login'))).toEqual([
    expect.stringMatching(/^run --rm --network host --env NODE_EXTRA_CA_CERTS=\/kit-home\/certificates\.pem --user \S+ --mount .* login$/),
  ]);
  expect(host.calls('xdg-open')).toEqual([LOGIN_LINK]);
});

it.each([
  ['natively on Linux', { system: 'Linux', machine: 'x86_64' }, [], ['--rooms', 'r_k2v.4,r_9qd.x']],
  ['natively on macOS', { system: 'Darwin', machine: 'arm64' }, [], ['--no-private']],
  ['in the container on Linux', { system: 'Linux', machine: 'x86_64' }, ['--container'], ['--no-private']],
  ['in the container on macOS', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }, ['--container'], ['--rooms', 'r_k2v.4,r_9qd.x']],
] as const)('passes the choice of Rooms through to kit login %s', async (_name, platform, placement, rooms) => {
  const host = await fakeHost(platform);

  const ran = host.run([...rooms, ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(logins(host, placement)).toEqual([expect.stringMatching(new RegExp(`(^| )login ${rooms.join(' ')}( |$)`))]);
});

it.each([
  ['natively on Linux', { system: 'Linux', machine: 'x86_64' }, []],
  ['natively on macOS', { system: 'Darwin', machine: 'arm64' }, []],
  ['in the container on Linux', { system: 'Linux', machine: 'x86_64' }, ['--container']],
  ['in the container on macOS', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }, ['--container']],
] as const)('passes a login code through to kit login %s', async (_name, platform, placement) => {
  const host = await fakeHost(platform);

  const ran = host.run(['--code', 'ahk_code_one', ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(logins(host, placement)).toEqual([expect.stringMatching(/(^| )login --code ahk_code_one( |$)/)]);
});

const CONNECTED = [
  ['natively on Linux', { system: 'Linux', machine: 'x86_64' }, []],
  ['natively on macOS', { system: 'Darwin', machine: 'arm64' }, []],
  ['natively on a Linux server', { system: 'Linux', machine: 'x86_64', server: true }, ['--linux']],
  ['in the container on Linux', { system: 'Linux', machine: 'x86_64' }, ['--container']],
  ['in the container on macOS', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }, ['--container']],
] as const;

async function connectedHost(platform: Platform, placement: readonly string[]): Promise<Host> {
  const host = await fakeHost(platform);
  if (platform.server === true) await host.mark('systemd');
  expect(host.run([...placement])).toMatchObject({ status: 0 });
  await host.forget();
  return host;
}

it.each(CONNECTED)('reuses the connected Environment without another login when a rerun names no Rooms %s', async (_name, platform, placement) => {
  const host = await connectedHost(platform, placement);

  expect(host.run([...placement])).toMatchObject({ status: 0, stderr: '' });

  expect(logins(host, placement)).toEqual([]);
});

it.each(CONNECTED)('sets the Rooms of the connected Environment again through kit login when a rerun names --no-private %s', async (_name, platform, placement) => {
  const host = await connectedHost(platform, placement);

  const ran = host.run(['--no-private', ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').slice(-3)).toEqual(['Kit is already installed.', LINK_LINE, '']);
  expect(logins(host, placement)).toEqual([expect.stringMatching(/(^| )login --no-private( |$)/)]);
});

it.each(CONNECTED)('sets the Rooms of the connected Environment again through kit login without the login code when a rerun names both %s', async (_name, platform, placement) => {
  const host = await connectedHost(platform, placement);

  const ran = host.run(['--code', 'ahk_code_unused', '--no-private', ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(logins(host, placement)).toEqual([expect.stringMatching(/(^| )login --no-private( HOUSE_KIT_HOME=\S+)?$/)]);
});

it('sets the Rooms of the connected Environment again through kit login when a rerun naming --no-private finds its Kit home but no container', async () => {
  const host = await connectedHost({ system: 'Linux', machine: 'x86_64' }, ['--container']);
  await host.clear('container');

  const ran = host.run(['--no-private', '--container']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').slice(-3)).toEqual(['Kit connected for Environment environment-one.', LINK_LINE, '']);
  expect(logins(host, ['--container'])).toEqual([expect.stringMatching(/ login --no-private$/)]);
});

it.each(CONNECTED)('leaves a login code unused when a rerun on the connected computer names no Rooms %s', async (_name, platform, placement) => {
  const host = await connectedHost(platform, placement);

  const ran = host.run(['--code', 'ahk_code_unused', ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe('Kit is already installed.');
  expect(logins(host, placement)).toEqual([]);
});

it('sets the Rooms of the connected Environment again through kit login when a rerun naming --no-private finds no service manager on the server', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true });
  expect(host.run(['--linux'])).toMatchObject({ status: 0 });
  await host.forget();

  const ran = host.run(['--no-private', '--linux']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').slice(-3)).toEqual([expect.stringContaining('no systemd runs on this host'), LINK_LINE, '']);
  expect(host.calls('kit')).toEqual([expect.stringMatching(/^login --no-private /)]);
});

const STARTED_AGAIN = [
  ['natively on Linux', { system: 'Linux', machine: 'x86_64' }, [], ['--user stop house-kit.service', '--user start house-kit.service']],
  [
    'natively on macOS',
    { system: 'Darwin', machine: 'arm64' },
    [],
    [`bootout gui/${UID}/house-kit`, `enable gui/${UID}/house-kit`, expect.stringMatching(/^bootstrap /)],
  ],
  [
    'natively on a Linux server',
    { system: 'Linux', machine: 'x86_64', server: true },
    ['--linux'],
    ['stop house-kit.service', 'daemon-reload', '--quiet enable --now house-kit.service'],
  ],
] as const;

it.each(
  STARTED_AGAIN.flatMap(([name, platform, placement, started]) =>
    (
      [
        ['fails', 'login-fails'],
        ['is abandoned', 'login-abandoned'],
      ] as const
    ).map(([outcome, mark]) => [outcome, name, mark, platform, placement, started] as const),
  ),
)(
  'starts the service a rerun updated before its kit login, which then %s, leaving the Kit running %s',
  async (_outcome, _name, mark, platform, placement, started) => {
    const host = await connectedHost(platform, placement);
    await host.outdate();
    await host.mark(mark);

    const ran = host.run(['--no-private', ...placement]);

    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toContain('Kit updated.\n');
    expect(acts(host)).toEqual(started);
    expect(logins(host, placement)).toEqual([expect.stringMatching(/(^| )login --no-private( |$)/)]);
  },
);

it.each(STARTED_AGAIN)('updates the Kit and leaves a login code unused when a rerun on the connected computer names no Rooms %s', async (_name, platform, placement, started) => {
  const host = await connectedHost(platform, placement);
  await host.outdate();

  const ran = host.run(['--code', 'ahk_code_unused', ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe('Kit updated.');
  expect(acts(host)).toEqual(started);
  expect(logins(host, placement)).toEqual([]);
});

it.each([
  ['natively on Linux', { system: 'Linux', machine: 'x86_64' }, []],
  ['natively on macOS', { system: 'Darwin', machine: 'arm64' }, []],
  ['in the container on Linux', { system: 'Linux', machine: 'x86_64' }, ['--container']],
  ['in the container on macOS', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }, ['--container']],
] as const)('passes the Kit relay to login and container runs %s', async (_name, platform, placement) => {
  const relay = 'https://kit-relay.example';
  const host = await fakeHost({ ...platform, environment: { HOUSE_KIT_RELAY: relay } });

  const ran = host.run(['--code', 'ahk_code_one', ...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  if (placement.length === 0) {
    expect(host.calls('relay')).toEqual([relay]);
    expect(host.calls('curl')).toEqual([
      expect.stringMatching(/ https:\/\/kit-relay\.example\/agents\.house\/kit-installer\/node-v24\.22\.1-\S+\.tar\.gz$/),
      expect.stringMatching(/ https:\/\/kit-relay\.example\/agents\.house\/kit-installer\/kit-0\.2\.1-alpha\.1\.tar\.gz$/),
    ]);
  } else {
    expect(host.calls('docker')).toContain(`pull --quiet --platform linux/amd64 kit-relay.example/agents.house/kit@sha256:${'a'.repeat(64)}`);
    const runs = host.calls('docker').filter((call) => call.startsWith('run '));
    expect(runs.length).toBeGreaterThan(1);
    const resident = runs.find((call) => call.endsWith(' resident'))!;
    expect(resident).not.toContain('HOUSE_KIT_RELAY');
    expect(runs.filter((call) => call !== resident).every((call) => call.includes(`--env HOUSE_KIT_RELAY=${relay}`))).toBe(true);
  }
});

it('passes the Kit relay to a command forwarded into the running Linux container', async () => {
  const relay = 'https://kit-relay.example';
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', environment: { HOUSE_KIT_RELAY: relay } });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.forget();

  const ran = host.run(['--container', 'house', 'list_environments']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('docker').filter((call) => call.startsWith('exec '))).toEqual([
    expect.stringMatching(new RegExp(`^exec -i --workdir \\S+ --env HOUSE_KIT_RELAY=${relay} house-kit house list_environments$`)),
  ]);
});

it.each([[['--rooms', 'r_k2v.4']], [['--no-private']]])('forwards kit login %j into the container', async (rooms) => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.forget();

  const ran = host.run(['--container', 'kit', 'login', ...rooms]);

  expect(ran).toEqual({ status: 0, stdout: `${LINK_LINE}\n`, stderr: '' });
  expect(host.calls('docker').filter((call) => / login( |$)/.test(call))).toEqual([
    expect.stringMatching(new RegExp(`^run --rm --network host --env NODE_EXTRA_CA_CERTS=/kit-home/certificates\\.pem --user \\S+ --mount .* login ${rooms.join(' ')}$`)),
  ]);
});

it('ends a kit login forwarded into the container with the status its login ended with', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.forget();
  await host.mark('login-fails');

  expect(host.run(['--container', 'kit', 'login'])).toMatchObject({ status: 7 });
});

it('stops the container after a kit logout forwarded into it, and leaves it running after kit logout --help', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.forget();

  expect(host.run(['--container', 'kit', 'logout', '--help'])).toMatchObject({ status: 0 });
  expect(host.calls('docker').filter((call) => /^(exec|stop) /.test(call))).toEqual(['exec -i house-kit kit logout --help']);
  await host.forget();

  expect(host.run(['--container', 'kit', 'logout'])).toMatchObject({ status: 0 });
  expect(host.calls('docker').filter((call) => /^(exec|stop) /.test(call))).toEqual(['exec -i house-kit kit logout', 'stop house-kit']);
});

it('forwards kit login --help into a stopped container alone, leaving it stopped', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.mark('stopped');
  await host.forget();

  expect(host.run(['--container', 'kit', 'login', '--help'])).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('docker').filter((call) => / login( |$)|^(start|stop) /.test(call))).toEqual([
    expect.stringMatching(/^run -i --rm .* login --help$/),
  ]);
});

it('keeps an installed container on the pinned image and on-failure, and replaces one under another restart policy on a rerun', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.forget();

  const kept = host.run(['--container']);

  expect(kept).toMatchObject({ status: 0, stderr: '' });
  expect(kept.stdout.split('\n').at(-2)).toBe('Kit is already installed.');
  expect(host.calls('docker').filter((call) => /^(rm|run -d) /.test(call))).toEqual([]);
  await host.restartPolicy('unless-stopped');
  await host.forget();

  const replaced = host.run(['--container']);

  expect(replaced).toMatchObject({ status: 0, stderr: '' });
  expect(replaced.stdout.split('\n').at(-2)).toBe('Kit updated.');
  expect(host.calls('docker').filter((call) => /^(rm|run -d) /.test(call))).toEqual([
    'rm -f house-kit',
    expect.stringMatching(/^run -d --name house-kit --restart on-failure .* resident$/),
  ]);
});

it('forwards kit and house only into the container', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });

  expect(host.run(['kit', 'login'])).toEqual({
    status: 1,
    stdout: '',
    stderr: 'kit_bootstrap_refused: this bootstrap forwards kit only into the container; add --container, or run kit directly\n',
  });
  expect(host.run(['--linux', '--container'])).toEqual({
    status: 1,
    stdout: '',
    stderr: 'kit_bootstrap_refused: --linux and --container are two placements; choose one\n',
  });
});
