import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { filesUnder, runKit, temporaryHome } from './kit.ts';

async function enrolled(house: House): Promise<string> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_own' }));
  house.route('POST', '/kit/logout', () => ({ body: {} }));
  return home;
}

async function contents(home: string): Promise<Record<string, string>> {
  const files = await filesUnder(home);
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')] as const)));
}

it('prints its usage on standard output for kit --help', async () => {
  const kit = runKit(['--help'], { HOUSE_KIT_HOME: await temporaryHome() });

  expect(await kit.exited).toBe(0);
  expect(kit.stdout()).toBe('usage: kit <login|logout|resident|codex>\n');
  expect(kit.stderr()).toBe('');
});

it('refuses kit --help with anything after it and prints no usage', async () => {
  const kit = runKit(['--help', '--bogus'], { HOUSE_KIT_HOME: await temporaryHome() });

  expect(await kit.exited).toBe(1);
  expect(kit.stdout()).toBe('');
  expect(kit.stderr()).toMatch(/^kit: /);
});

it.each(['logout', 'resident', 'git-credential', 'codex'])(
  'prints kit %s --help on standard output and leaves an enrolled home and its House untouched',
  async (command) => {
    const house = await startHouse();
    const home = await enrolled(house);
    const before = await contents(home);

    const kit = runKit([command, '--help'], { HOUSE_KIT_HOME: home });
    kit.input.end();

    expect(await kit.exited).toBe(0);
    expect(kit.stdout()).toMatch(new RegExp(`^usage: kit ${command}\\b`));
    expect(kit.stderr()).toBe('');
    expect(house.requests).toEqual([]);
    expect(await contents(home)).toEqual(before);
  },
);

it.each([[['logout', '--force']], [['resident', 'now']], [['git-credential', 'get', 'store']]])(
  'refuses kit %j, an argument its command does not take, and leaves an enrolled home and its House untouched',
  async (argv) => {
    const house = await startHouse();
    const home = await enrolled(house);
    const before = await contents(home);

    const kit = runKit(argv, { HOUSE_KIT_HOME: home });
    kit.input.end();

    expect(await kit.exited).toBe(1);
    expect(kit.stdout()).toBe('');
    expect(kit.stderr()).toMatch(/^kit: /);
    expect(house.requests).toEqual([]);
    expect(await contents(home)).toEqual(before);
  },
);
