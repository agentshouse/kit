import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { hostKit, opened } from './environment.ts';
import { accountOf, filesUnder, runKit, temporaryHome } from './kit.ts';

const VERBS = ['login', 'logout', 'connect', 'resident', 'settings'];
const INSIDE = 'does not run inside an Agent conversation or a function run; run it in your own terminal';

async function enrolled(house: House): Promise<string> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  house.route('POST', '/kit/kits/log-out', () => ({ body: {} }));
  return home;
}

async function contents(home: string): Promise<Record<string, string>> {
  const files = await filesUnder(home);
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')] as const)));
}

it.each(['login', 'logout', 'connect', 'resident', 'settings', 'git-credential'])(
  'prints house %s --help on standard output and leaves an enrolled home and its House untouched',
  async (verb) => {
    const house = await startHouse();
    const home = await enrolled(house);
    const before = await contents(home);

    const kit = runKit([verb, '--help'], { HOME: accountOf(home) });
    kit.input.end();

    expect(await kit.exited).toBe(0);
    expect(kit.stdout()).toMatch(new RegExp(`^usage: house ${verb}\\b`));
    expect(kit.stderr()).toBe('');
    expect(house.requests).toEqual([]);
    expect(await contents(home)).toEqual(before);
  },
);

it.each([[['logout', '--force']], [['resident', 'now']], [['git-credential', 'get', 'store']]])(
  'refuses house %j, an argument its verb does not take, and leaves an enrolled home and its House untouched',
  async (argv) => {
    const house = await startHouse();
    const home = await enrolled(house);
    const before = await contents(home);

    const kit = runKit(argv, { HOME: accountOf(home) });
    kit.input.end();

    expect(await kit.exited).toBe(1);
    expect(kit.stdout()).toBe('');
    expect(kit.stderr()).toMatch(/^house: /);
    expect(house.requests).toEqual([]);
    expect(await contents(home)).toEqual(before);
  },
);

it('refuses house login, logout, connect, resident and settings in one line each inside an Agent conversation, ending no connection', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/kits/log-out', () => ({ body: {} }));
  await opened(hosted);
  const before = await readFile(join(hosted.home, 'credential.json'), 'utf8');

  hosted.call({ kind: 'message', text: `@sh for verb in ${VERBS.join(' ')}; do house $verb 2>&1; echo "exit $?"; done`, first: false });

  const ran = await until(async () => (await hosted.adapterLog()).find((entry) => 'sh' in entry) as { stdout: string } | undefined);
  expect(ran.stdout).toBe(VERBS.map((verb) => `house: house ${verb} ${INSIDE}\nexit 1\n`).join(''));
  expect(hosted.house.requests.filter((received) => received.path === '/kit/kits/log-out')).toEqual([]);
  expect(await readFile(join(hosted.home, 'credential.json'), 'utf8')).toBe(before);
});
