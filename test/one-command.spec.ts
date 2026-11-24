import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { KIT_RELEASE } from '../src/clis.ts';
import { startHouse, until } from './double.ts';
import { hostKit, macOS } from './environment.ts';
import { accountOf, runKit, temporaryHome } from './kit.ts';
import { ROOTED, supervision } from './supervision.ts';

const STARTED_AS_KIT = { HOUSE_KIT_COMMAND: 'kit' };
const OWN_AGENT = JSON.stringify({ house: 'https://agents.house', user: 'user-one', credential: 'ahp_own' });

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function namingKit(home: string): Promise<void> {
  await put(join(home, 'bin', 'kit'), '#!/bin/sh\n');
  await chmod(join(home, 'bin', 'kit'), 0o755);
  await put(join(home, 'own-agent.json'), OWN_AGENT);
  await put(join(accountOf(home), '.gitconfig'), '[credential "https://agents.house/app/"]\n\thelper =\n\thelper = !kit git-credential\n');
}

function helpers(home: string): string {
  return spawnSync('git', ['config', '--global', '--get-all', 'credential.https://agents.house/app/.helper'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: accountOf(home), GIT_CONFIG_NOSYSTEM: '1' },
  }).stdout;
}

async function folded(home: string): Promise<void> {
  expect(helpers(home)).toBe('\n!house git-credential\n');
  await absent(join(home, 'own-agent.json'));
}

function unitNaming(home: string, command: string): string {
  return `[Unit]\nDescription=Kit\n\n[Service]\nExecStart="${join(home, 'bin', command)}" resident\nRestart=on-failure\nRestartSec=5\nDelegate=yes\nOOMPolicy=continue\n\n[Install]\nWantedBy=default.target\n`;
}

function agentNaming(home: string, command: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>house-kit</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${join(home, 'bin', command)}</string>\n\t\t<string>resident</string>\n\t</array>\n</dict>\n</plist>\n`;
}

it("names house in a Linux home's unit and Git helper that named kit and deletes its own agent's file at the release's first start, once, and reports the release", async () => {
  const tools = await supervision();
  await tools.systemd();
  const home = await temporaryHome();
  const unit = join(accountOf(home), '.config', 'systemd', 'user', 'house-kit.service');
  const hosted = await hostKit([], {
    home,
    skills: [],
    node: ROOTED,
    environment: { ...tools.environment, PATH: `${join(tools.fake, 'bin')}:${join(home, 'bin')}:${process.env.PATH}`, XDG_CONFIG_HOME: join(accountOf(home), '.config'), ...STARTED_AS_KIT },
    prepare: async () => {
      await namingKit(home);
      await put(unit, unitNaming(home, 'kit'));
    },
  });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  expect(await readFile(unit, 'utf8')).toContain(`\nExecStart="${join(home, 'bin', 'house')}" resident\n`);
  expect(tools.calls('systemctl')).toEqual(['--user daemon-reload']);
  await folded(home);
  await absent(join(home, 'bin', 'kit'));
  const written = await stat(unit);

  await hosted.restart();

  expect(tools.calls('systemctl')).toEqual(['--user daemon-reload']);
  expect((await stat(unit)).mtimeMs).toBe(written.mtimeMs);
  expect(helpers(home)).toBe('\n!house git-credential\n');
});

it('removes the kit links its installer placed in /usr/local/bin and ~/.local/bin as it drops kit, and no other link or file', async () => {
  const tools = await supervision();
  const home = await temporaryHome();
  const account = accountOf(home);
  const systemBin = join(tools.root, 'usr', 'local', 'bin');

  const hosted = await hostKit([], {
    home,
    skills: [],
    node: ROOTED,
    environment: { ...tools.environment, PATH: `${join(tools.fake, 'bin')}:${join(home, 'bin')}:${process.env.PATH}` },
    prepare: async () => {
      await namingKit(home);
      await mkdir(systemBin, { recursive: true });
      await mkdir(join(account, '.local', 'bin'), { recursive: true });
      await symlink(join(home, 'bin', 'kit'), join(systemBin, 'kit'));
      await symlink(join(home, 'bin', 'kit'), join(account, '.local', 'bin', 'kit'));
      await symlink(join(home, 'bin', 'house'), join(account, '.local', 'bin', 'house'));
      await put(join(systemBin, 'house'), 'mine\n');
    },
  });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  await absent(join(home, 'bin', 'kit'));
  await absent(join(systemBin, 'kit'));
  await absent(join(account, '.local', 'bin', 'kit'));
  expect(await readlink(join(account, '.local', 'bin', 'house'))).toBe(join(home, 'bin', 'house'));
  expect(await readFile(join(systemBin, 'house'), 'utf8')).toBe('mine\n');
});

it("names house in a Mac's LaunchAgent and Git helper that named kit at its first start through kit, reloads the LaunchAgent, and drops kit at the start that follows", async () => {
  const tools = await supervision();
  const home = await temporaryHome();
  const agent = join(accountOf(home), 'Library', 'LaunchAgents', 'house-kit.plist');
  await namingKit(home);
  await put(agent, agentNaming(home, 'kit'));
  await put(join(home, 'credential.json'), JSON.stringify({ house: 'https://agents.house', environment: 'environment-one', credential: 'ahk_held' }));
  const launchd = join(tools.fake, 'launchd');
  await put(join(launchd, 'launchctl'), '#!/bin/sh\nprintf \'%s %s\\n\' "${0##*/}" "$*" >> "$FAKE/log"\n[ "$1" != bootout ] || kill -TERM "$(cut -d" " -f4 "/proc/$PPID/stat")"\n');
  await chmod(join(launchd, 'launchctl'), 0o755);
  const mac = await macOS(home);
  const environment = { ...mac, PATH: `${launchd}:${mac.PATH}`, FAKE: tools.fake };

  const first = runKit(['resident'], { HOME: accountOf(home), ...environment, ...STARTED_AS_KIT });

  expect(await first.exited).toBe(null);
  const target = `gui/${process.getuid!()}`;
  expect(await until(() => tools.calls('launchctl').length === 2 && tools.calls('launchctl'))).toEqual([`bootout ${target}/house-kit`, `bootstrap ${target} ${agent}`]);
  expect(await readFile(agent, 'utf8')).toContain(`<string>${join(home, 'bin', 'house')}</string>\n\t\t<string>resident</string>`);
  await folded(home);
  await lstat(join(home, 'bin', 'kit'));

  const hosted = await hostKit([], { home, skills: [], environment });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  await absent(join(home, 'bin', 'kit'));
  expect(tools.calls('launchctl')).toHaveLength(2);
});

it("keeps a Sandbox's resident running through the release when its loop still runs kit resident", async () => {
  const home = await temporaryHome();

  const hosted = await hostKit([], { home, skills: [], environment: { HOUSE_KIT_SANDBOX: '1', ...STARTED_AS_KIT }, prepare: () => namingKit(home) });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  await folded(home);
  await lstat(join(home, 'bin', 'kit'));
});

it("says in one line to run house resident where its owner's own service manager runs kit resident, connects nothing and stays stopped, and passes once it starts as house resident", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await namingKit(home);
  await put(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));

  const kit = runKit(['resident'], { HOME: accountOf(home), ...STARTED_AS_KIT });

  expect(await kit.exited).toBe(0);
  expect(kit.stderr()).toBe(`kit: kit resident is now house resident; make your service manager run '${join(home, 'bin', 'house')}' resident\n`);
  expect(house.requests).toEqual([]);
  await folded(home);
  await lstat(join(home, 'bin', 'kit'));

  const hosted = await hostKit([], { home, skills: [] });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  await absent(join(home, 'bin', 'kit'));
});

it("ends before it connects while the step fails, naming why and keeping kit, and passes at the start that follows", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const locked = join(accountOf(home), '.gitconfig.lock');
  await namingKit(home);
  await put(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));
  await put(locked, '');

  const kit = runKit(['resident'], { HOME: accountOf(home) });

  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toMatch(
    /^kit: the kit command could not be folded into house, so Kit does not connect; it tries again at its next start: git config failed: [^\n]*could not lock config file[^\n]*\n$/,
  );
  expect(house.requests).toEqual([]);
  expect(helpers(home)).toBe('\n!kit git-credential\n');
  await lstat(join(home, 'bin', 'kit'));

  await rm(locked);
  const hosted = await hostKit([], { home, skills: [] });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  await folded(home);
  await absent(join(home, 'bin', 'kit'));
});
