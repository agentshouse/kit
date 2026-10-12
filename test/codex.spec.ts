import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { certificate, startHouse, type House } from './double.ts';
import { LOGIN_SHELL } from './environment.ts';
import { fakeBin, filesUnder, runKit, temporaryHome } from './kit.ts';

const KEY = 'ahp_script_key';

interface Machine {
  home: string;
  bin: string;
  ran: string;
  environment: Record<string, string>;
}

function serveKey(house: House): void {
  house.route('POST', '/', ({ body, headers }) => {
    if (headers.authorization !== `Bearer ${KEY}`) return { status: 401, body: {} };
    const message = body as { id: string; method: string };
    const result = message.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'room_ref: r_one' }] };
    return { body: { jsonrpc: '2.0', id: message.id, result } };
  });
}

async function placeScript(path: string, lines: string[]): Promise<void> {
  await writeFile(path, ['#!/bin/sh', ...lines, ''].join('\n'));
  await chmod(path, 0o755);
}

async function machine(withCodex = true): Promise<Machine> {
  const home = await temporaryHome();
  const tools = await temporaryHome();
  const path = await fakeBin(tools);
  const bin = join(tools, 'bin');
  const ran = join(tools, 'ran');
  await mkdir(ran);
  if (withCodex) {
    await placeScript(join(bin, 'codex'), [
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${ran}/argv'`,
      `printf '%s\\n' "$HOUSE_KIT_HOME" > '${ran}/home'`,
      `cp "$HOME/.codex/rules/house.rules" '${ran}/rule'`,
      `house list_rooms > '${ran}/house' 2>&1`,
      'exit 7',
    ]);
  }
  for (const manager of ['systemctl', 'launchctl']) await placeScript(join(bin, manager), [`echo "$0 $*" >> '${ran}/service'`]);
  return { home, bin, ran, environment: { HOME: home, CODEX_HOME: '', PATH: path, NODE_EXTRA_CA_CERTS: certificate().path, ...LOGIN_SHELL } };
}

function codexRule(houses: string[]): string {
  return `prefix_rule(pattern = ["house"], decision = "allow")\nhost_executable(name = "house", paths = ${JSON.stringify(houses)})\n`;
}

function ran(machine: Machine, name: string): Promise<string> {
  return readFile(join(machine.ran, name), 'utf8');
}

function calls(house: House): [unknown, unknown][] {
  return house.requests.map((request) => [request.headers.authorization, (request.body as { method: string }).method]);
}

async function holding(machine: Machine, house: House): Promise<string> {
  const outside = join(machine.home, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'own-agent.json'), JSON.stringify({ house: house.origin, credential: KEY }));
  return outside;
}

it("writes the key into a Kit home of its own and Codex's rule, then runs codex with the remaining arguments there, so a lone house reaches House over HTTPS as the key", async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const computer = await machine();

  const kit = runKit(['codex', '--key', KEY, '--house', house.origin, 'exec', '--model', 'gpt-5.5', 'fix the invoice App'], computer.environment);

  expect(await kit.exited).toBe(7);
  expect(await ran(computer, 'argv')).toBe('exec\n--model\ngpt-5.5\nfix the invoice App\n');
  expect(await ran(computer, 'home')).toBe(`${join(computer.home, '.house-kit-outside')}\n`);
  expect(await ran(computer, 'rule')).toBe(codexRule([join(computer.bin, 'house')]));
  expect(await ran(computer, 'house')).toBe('room_ref: r_one\n');
  expect(calls(house)).toEqual([
    [`Bearer ${KEY}`, 'tools/list'],
    [`Bearer ${KEY}`, 'tools/call'],
  ]);
  expect(JSON.parse(await readFile(join(computer.home, '.house-kit-outside', 'own-agent.json'), 'utf8'))).toEqual({
    house: house.origin,
    credential: KEY,
  });
  expect((await filesUnder(computer.home)).sort()).toEqual([
    join(computer.home, '.codex', 'rules', 'house.rules'),
    join(computer.home, '.house-kit-outside', 'own-agent.json'),
  ]);
  await expect(access(join(computer.ran, 'service'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('runs a plain kit codex with the key and House the Kit home named by $HOUSE_KIT_HOME holds, checking nothing with House first', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const computer = await machine();
  const outside = await holding(computer, house);

  const kit = runKit(['codex'], { ...computer.environment, HOUSE_KIT_HOME: outside });

  expect(await kit.exited).toBe(7);
  expect(await ran(computer, 'argv')).toBe('');
  expect(await ran(computer, 'home')).toBe(`${outside}\n`);
  expect(await ran(computer, 'house')).toBe('room_ref: r_one\n');
  expect(calls(house)).toEqual([[`Bearer ${KEY}`, 'tools/call']]);
});

it('finds codex through a relative PATH entry, as the shell does', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const computer = await machine();
  const outside = await holding(computer, house);

  const kit = runKit(['codex', 'resume'], {
    ...computer.environment,
    HOUSE_KIT_HOME: outside,
    PATH: `${relative(process.cwd(), computer.bin)}:${process.env.PATH}`,
  });

  expect(await kit.exited).toBe(7);
  expect(await ran(computer, 'argv')).toBe('resume\n');
  expect(await ran(computer, 'house')).toBe('room_ref: r_one\n');
});

it('refuses a plain kit codex whose Kit home holds no key, naming where a key comes from, and writes nothing and runs no codex', async () => {
  const computer = await machine();

  const kit = runKit(['codex', 'exec', 'fix it'], computer.environment);

  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toBe(
    `kit: ${join(computer.home, '.house-kit-outside')} holds no House key; pass --key with one from New key for a script on Connections\n`,
  );
  expect(await filesUnder(computer.home)).toEqual([]);
  expect(await filesUnder(computer.ran)).toEqual([]);
});

it.each([
  ['a key its House does not accept', ['--key', 'ahp_revoked'], (house: House) => `kit: ${house.origin} does not accept this key; pass one from New key for a script on Connections\n`],
  ['--house without a key', ['--house', 'https://dev.agents.house'], () => 'kit: --house names the House of a --key; pass the key with it\n'],
])('refuses %s, keeps the key its Kit home holds and runs no codex', async (_name, argv, refusal) => {
  const house = await startHouse(certificate());
  serveKey(house);
  const computer = await machine();
  const outside = await holding(computer, house);
  const held = await readFile(join(outside, 'own-agent.json'), 'utf8');

  const kit = runKit(['codex', ...argv], { ...computer.environment, HOUSE_KIT_HOME: outside });

  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toBe(refusal(house));
  expect(await readFile(join(outside, 'own-agent.json'), 'utf8')).toBe(held);
  expect(await filesUnder(computer.ran)).toEqual([]);
});

it('ends naming the install command when codex is not on the PATH, keeping the key for a later plain kit codex', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const computer = await machine(false);

  const kit = runKit(['codex', '--key', KEY, '--house', house.origin], computer.environment);

  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toBe('kit: codex is not on your PATH; install it with curl -fsSL https://chatgpt.com/codex/install.sh | sh\n');
  expect(JSON.parse(await readFile(join(computer.home, '.house-kit-outside', 'own-agent.json'), 'utf8'))).toEqual({
    house: house.origin,
    credential: KEY,
  });
});
