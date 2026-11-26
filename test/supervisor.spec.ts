import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { KIT_RELEASE } from '../src/clis.ts';
import { until } from './double.ts';
import { hostKit, macOS } from './environment.ts';
import { accountOf, runKit, temporaryHome } from './kit.ts';
import { ROOTED, supervision, type Supervision } from './supervision.ts';

const SIGNAL_ENDS_CLEAN = 'Restart=on-failure\nRestartSec=5\nDelegate=yes\nOOMPolicy=continue';
const RESTARTS_ALL_BUT_EXIT_0 = 'Restart=always\nRestartPreventExitStatus=0\nRestartSec=5\nOOMPolicy=continue';

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function unitWith(home: string, service: string): string {
  return `[Unit]\nDescription=Kit\n\n[Service]\nExecStart="${join(home, 'bin', 'house')}" resident\n${service}\n\n[Install]\nWantedBy=default.target\n`;
}

function reloads(tools: Supervision): string[] {
  return tools.calls('systemctl').filter((call) => call === '--user daemon-reload');
}

async function linux(service: string, marks: string[] = []) {
  const tools = await supervision();
  await tools.systemd();
  for (const mark of marks) await tools.mark(mark);
  const home = await temporaryHome();
  const unit = join(accountOf(home), '.config', 'systemd', 'user', 'house-kit.service');
  let placed = 0;
  const hosted = await hostKit([], {
    home,
    skills: [],
    node: ROOTED,
    environment: { ...tools.environment, XDG_CONFIG_HOME: join(accountOf(home), '.config') },
    prepare: async () => {
      await put(unit, unitWith(home, service));
      placed = (await stat(unit)).mtimeMs;
    },
  });
  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  return { tools, home, unit, hosted, placed };
}

it("rewrites a Linux unit an earlier release wrote, under which a Kit a signal ended stays stopped, at the release's first start, has systemd read it once, and keeps it at the start that follows", async () => {
  const { tools, home, unit, hosted } = await linux(SIGNAL_ENDS_CLEAN);

  expect(await readFile(unit, 'utf8')).toBe(unitWith(home, RESTARTS_ALL_BUT_EXIT_0));
  expect(reloads(tools)).toEqual(['--user daemon-reload']);
  const written = await stat(unit);

  await hosted.restart();

  expect(reloads(tools)).toEqual(['--user daemon-reload']);
  expect((await stat(unit)).mtimeMs).toBe(written.mtimeMs);
});

it('has systemd read a current unit it has not read yet, as after a start whose reload failed, once, and writes nothing', async () => {
  const { tools, unit, hosted, placed } = await linux(RESTARTS_ALL_BUT_EXIT_0, ['unread']);

  expect(reloads(tools)).toEqual(['--user daemon-reload']);

  await hosted.restart();

  expect(reloads(tools)).toEqual(['--user daemon-reload']);
  expect((await stat(unit)).mtimeMs).toBe(placed);
});

it("reloads a Mac's LaunchAgent an earlier release wrote otherwise at the release's first start, and keeps it at the start that follows", async () => {
  const tools = await supervision();
  const home = await temporaryHome();
  const agent = join(accountOf(home), 'Library', 'LaunchAgents', 'house-kit.plist');
  await put(
    agent,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>house-kit</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${join(home, 'bin', 'house')}</string>\n\t\t<string>resident</string>\n\t</array>\n</dict>\n</plist>\n`,
  );
  await put(join(home, 'credential.json'), JSON.stringify({ house: 'https://agents.house', environment: 'environment-one', credential: 'ahk_held' }));
  const launchd = await tools.bootingOut();
  const mac = await macOS(home);
  const environment = { ...mac, PATH: `${launchd}:${mac.PATH}`, FAKE: tools.fake };

  const first = runKit(['resident'], { HOME: accountOf(home), ...environment });

  expect(await first.exited).toBe(null);
  const target = `gui/${process.getuid!()}`;
  expect(await until(() => tools.calls('launchctl').length === 2 && tools.calls('launchctl'))).toEqual([`bootout ${target}/house-kit`, `bootstrap ${target} ${agent}`]);
  expect(await readFile(agent, 'utf8')).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  const written = await stat(agent);

  const hosted = await hostKit([], { home, skills: [], environment });

  expect(await until(() => hosted.reports[0])).toMatchObject({ kit_release: KIT_RELEASE });
  expect(tools.calls('launchctl')).toHaveLength(2);
  expect((await stat(agent)).mtimeMs).toBe(written.mtimeMs);
});
