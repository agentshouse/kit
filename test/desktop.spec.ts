import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fakeHost, LOGIN_LINK, PUBLISHED_VERSION, type Host } from './host.ts';
import { temporaryHome } from './kit.ts';

const UNSUPPORTED = 'it installs without that guarantee.';
const UID = process.getuid!();

function acts(host: Host): string[] {
  return [...host.calls('systemctl'), ...host.calls('launchctl')].filter((call) => !/^(--user is-active|print) /.test(call));
}

function notices(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.endsWith(UNSUPPORTED));
}

async function installed(host: Host): Promise<void> {
  const prefix = join(host.home, '.local', 'share', 'house-kit');
  expect(await readFile(join(prefix, 'release'), 'utf8')).toBe(`@agentshouse/kit@${PUBLISHED_VERSION} node@24.21.0\n`);
  for (const command of ['kit', 'house']) {
    expect(host.command(command, ['--help'])).toMatchObject({ status: 0 });
    expect(host.calls(command).at(-1)).toMatch(/^--help /);
  }
  expect((await stat(join(host.home, 'AgentsHouse'))).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(join(host.home, '.house-kit', 'credential.json'), 'utf8'))).toMatchObject({
    environment: 'environment-one',
  });
}

function userUnit(home: string, workspace = join(home, 'AgentsHouse')): string {
  return `[Unit]
Description=House Kit
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Environment="HOUSE_KIT_WORKSPACE=${workspace}"
ExecStart="${home}/.local/bin/kit" resident
Restart=on-failure
RestartSec=5

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
  expect(ran.stdout).toContain('House Kit connected for Environment environment-one.\n');
  expect(host.calls('curl')).toEqual([expect.stringMatching(/ https:\/\/nodejs\.org\/dist\/v24\.21\.0\/node-v24\.21\.0-linux-x64\.tar\.gz$/)]);
  expect(host.calls('sha256sum')).toEqual(['--check']);
  expect(host.calls('npm')).toEqual([expect.stringMatching(/ @agentshouse\/kit@0\.2\.1-alpha\.1$/)]);
  expect(host.calls('sudo')).toEqual([]);
  expect(host.calls('docker')).toEqual(['container inspect house-kit']);
  expect(host.calls('kit')).toEqual([`login HOUSE_KIT_HOME=${host.home}/.house-kit`]);
  expect(host.calls('xdg-open')).toEqual([LOGIN_LINK]);
  expect(acts(host)).toEqual(['--user daemon-reload', '--user --quiet enable --now house-kit.service']);
  expect(await readFile(join(host.home, '.config', 'systemd', 'user', 'house-kit.service'), 'utf8')).toBe(userUnit(host.home));
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe(`export PATH="${host.home}/.local/bin:$PATH"\n`);
  await installed(host);
});

it("installs Kit natively beneath the home on macOS as the User's LaunchAgent, without elevation, and enrols through kit login", async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', shell: 'zsh' });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('House Kit connected for Environment environment-one.\n');
  expect(notices(ran.stdout)).toEqual([]);
  expect(host.calls('curl')).toEqual([expect.stringMatching(/ https:\/\/nodejs\.org\/dist\/v24\.21\.0\/node-v24\.21\.0-darwin-arm64\.tar\.gz$/)]);
  expect(host.calls('shasum')).toEqual(['-a 256 --check']);
  expect(host.calls('sudo')).toEqual([]);
  expect(host.calls('open')).toEqual([LOGIN_LINK]);
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
    expect(ran.stdout).toContain('House Kit is already installed.\n');
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
  ['Linux', { system: 'Linux', machine: 'x86_64' }, ['--user daemon-reload', '--user restart house-kit.service']],
  ['macOS', { system: 'Darwin', machine: 'arm64' }, [`bootout gui/${UID}/house-kit`, `enable gui/${UID}/house-kit`, expect.stringMatching(/^bootstrap /)]],
] as const)('restarts the %s service in place when a rerun moves the workspace root', async (_name, platform, restart) => {
  const host = await fakeHost(platform);
  expect(host.run()).toMatchObject({ status: 0 });
  await host.forget();

  const ran = host.run(['--workspace', join(host.home, 'Agents')]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('House Kit restarted for Environment environment-one.\n');
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

  expect(ran.stdout).toContain('House Kit restarted for Environment environment-one.\n');
  expect(acts(host)).toEqual(['--user restart house-kit.service']);
});

it("updates every chosen CLI the native placement's Kit names with its own update command under --update-clis, and leaves the running service alone", async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  const codex = join(host.home, 'codex');
  await writeFile(codex, '#!/bin/sh\nprintf \'codex %s\\n\' "$*" >> "$FAKE/log"\n', { mode: 0o755 });
  await writeFile(join(host.home, '.clis'), `codex\t${codex}\t0.160.0\t0.159.1\tcurrent\n`);
  await host.forget();

  const ran = host.run(['--update-clis']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Updating codex 0.160.0.\n');
  expect(host.calls('node')).toContain('clis-main.js');
  expect(host.calls('codex')).toEqual(['update']);
  expect(acts(host)).toEqual([]);
});

it.each([
  ['a Linux host outside the native contract', { system: 'Linux', machine: 'aarch64' }, 'Ubuntu 26.04 LTS on amd64, not Debian GNU/Linux 12 (bookworm) on arm64', 'linux-arm64'],
  ['a Linux host on another architecture Node.js is built for', { system: 'Linux', machine: 'ppc64le' }, 'Ubuntu 26.04 LTS on amd64, not Debian GNU/Linux 12 (bookworm) on ppc64le', 'linux-ppc64le'],
] as const)('prints exactly one unsupported notice on %s and installs', async (_name, platform, notice, node) => {
  const host = await fakeHost(platform);

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(notices(ran.stdout)).toEqual([`House Kit supports ${notice}; ${UNSUPPORTED}`]);
  expect(host.calls('curl')).toEqual([expect.stringContaining(`/node-v24.21.0-${node}.tar.gz`)]);
  await installed(host);
});

it('warns in one line on a macOS older than the supported release and installs', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', macos: '26.7.1' });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').filter((line) => /macOS|guarantee/.test(line))).toEqual([
    'Warning: macOS 26.7.1 is outdated; update to macOS 27.',
  ]);
  expect(host.calls('curl')).toEqual([expect.stringContaining('/node-v24.21.0-darwin-arm64.tar.gz')]);
  await installed(host);
});

it('says nothing about the system on the supported macOS release on Apple silicon', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'arm64', appleSilicon: true });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).not.toMatch(/macOS|guarantee|Apple silicon/);
});

it('warns once on an Intel Mac and installs', async () => {
  const host = await fakeHost({ system: 'Darwin', machine: 'x86_64', appleSilicon: false });

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').filter((line) => line.startsWith('Warning:'))).toEqual([
    'Warning: House Kit supports Apple silicon, not an Intel chip.',
  ]);
  await installed(host);
});

it('says the Kit updated when a rerun installs a newer release', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  await writeFile(join(host.home, '.local', 'share', 'house-kit', 'release'), '@agentshouse/kit@0.2.1-alpha.0 node@24.21.0\n');

  const ran = host.run();

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe('House Kit updated.');
});

const OTHER_ACCOUNT = 'House Kit is already installed for another account. Replace it? [y/N]';

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

it('asks from the terminal, while the script arrives on standard input, whether to replace a Kit of another House account, and installs afresh on yes', async () => {
  const host = await heldByAnotherAccount();

  const ran = host.terminal(HOUSE, 'y\n');

  expect(ran.status).toBe(0);
  expect(ran.stdout.match(/Replace it\?/g)).toHaveLength(1);
  expect(ran.stdout).toContain(OTHER_ACCOUNT);
  expect(ran.stdout).toContain('House Kit connected for Environment environment-one.');
  expect(host.calls('kit')).toEqual([`login --house https://agents.house HOUSE_KIT_HOME=${host.home}/.house-kit`]);
  expect(host.calls('systemctl')).toEqual(expect.arrayContaining(['--user stop house-kit.service', '--user --quiet enable --now house-kit.service']));
  await expect(access(join(host.home, '.house-kit', 'own-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(host.home, 'AgentsHouse', 'notes.md'), 'utf8')).toBe('kept\n');
});

it('keeps a Kit of another House account when the User declines, and refuses without a terminal', async () => {
  const host = await heldByAnotherAccount();

  const declined = host.terminal(HOUSE, 'n\n');
  expect(declined.status).toBe(1);
  expect(declined.stdout).toContain(OTHER_ACCOUNT);
  expect(declined.stdout).toContain('kit_bootstrap_refused: Environment environment-one was kept; nothing changed');
  expect(host.run(HOUSE)).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: this Environment is bound to another House origin\n',
  });

  expect(host.calls('kit')).toEqual([]);
  expect(await readFile(join(host.home, '.house-kit', 'own-agent.json'), 'utf8')).toBe('{"user":"user-one"}\n');
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

it('refuses a Linux architecture Node.js is not built for before installing anything', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'armv7l' });

  expect(host.run()).toEqual({ status: 1, stdout: '', stderr: 'kit_bootstrap_refused: unsupported Linux architecture armv7l\n' });
  await expect(access(join(host.home, '.local'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([['--container'], ['--linux']])(
  'refuses %s on a Linux architecture only the native desktop placement takes, before touching the host',
  async (choice) => {
    const host = await fakeHost({ system: 'Linux', machine: 's390x' });

    expect(host.run([choice])).toEqual({ status: 1, stdout: '', stderr: 'kit_bootstrap_refused: unsupported Linux architecture s390x\n' });
    expect([...host.calls('sudo'), ...host.calls('docker'), ...host.calls('curl')]).toEqual([]);
  },
);

it('installs the container exactly as before only with the container choice', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  const image = `ghcr.io/agentshouse/kit@sha256:${'a'.repeat(64)}`;
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const mounts = `--mount type=bind,"src=${host.home}/.house-kit",dst=/kit-home --mount type=bind,"src=${host.home}/AgentsHouse",dst=/agents/house`;

  const ran = host.run(['--container']);

  expect(ran).toEqual({
    status: 0,
    stdout: `Opening House Login in the host browser: ${LOGIN_LINK}\nHouse Kit connected for Environment environment-one.\n`,
    stderr: '',
  });
  expect(host.calls('docker')).toEqual([
    'info --format {{.OSType}}/{{.Architecture}}',
    'container inspect house-kit',
    `pull --quiet --platform linux/amd64 ${image}`,
    `run --rm --network host --user ${uid} ${mounts} ${image} login`,
    `run --entrypoint node --rm --network host --user ${uid} ${mounts} ${image} /usr/local/lib/node_modules/@agentshouse/kit/dist/configure-main.js`,
    `run --entrypoint node --rm --network host --user ${uid} ${mounts} ${image} /usr/local/lib/node_modules/@agentshouse/kit/dist/clis-main.js`,
    `run -d --name house-kit --restart unless-stopped --user ${uid} ${mounts} --label agentshouse.house=https://agents.house ${image} resident`,
  ]);
  expect(host.calls('xdg-open')).toEqual([LOGIN_LINK]);
  expect([...host.calls('curl'), ...host.calls('systemctl'), ...host.calls('sudo')]).toEqual([]);
  await expect(access(join(host.home, '.local'))).rejects.toMatchObject({ code: 'ENOENT' });
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
