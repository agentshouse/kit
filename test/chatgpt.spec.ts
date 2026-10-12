import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { certificate, startHouse, type House } from './double.ts';
import { entriesUnder, placeKitHouse, runKit, temporaryHome } from './kit.ts';
import { ownAgent } from './login.ts';

const KEY = 'ahp_script_key';
const SPAWNED = ['systemctl', 'launchctl', 'git', 'xdg-open', 'open', 'ps', 'codex', 'claude', 'grok', 'npm', 'curl', 'docker', 'login-shell'];

interface Container {
  home: string;
  kitHome: string;
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

async function freshContainer(): Promise<Container> {
  const home = await temporaryHome();
  const tools = await temporaryHome();
  const bin = join(tools, 'bin');
  const ran = join(tools, 'ran');
  await mkdir(bin);
  await mkdir(ran);
  await placeKitHouse(bin);
  for (const name of SPAWNED) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${ran}/log'\n`);
    await chmod(join(bin, name), 0o755);
  }
  return {
    home,
    kitHome: join(home, '.house-kit'),
    ran,
    environment: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: join(bin, 'login-shell'), NODE_EXTRA_CA_CERTS: certificate().path },
  };
}

function inContainer(container: Container, command: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env: container.environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function calls(house: House): [unknown, unknown][] {
  return house.requests.map((request) => [request.headers.authorization, (request.body as { method: string }).method]);
}

async function holdEarlierKey(container: Container, house: House): Promise<string> {
  await mkdir(container.kitHome);
  await writeFile(join(container.kitHome, 'own-agent.json'), JSON.stringify({ house: house.origin, credential: 'ahp_earlier_key' }));
  return readFile(join(container.kitHome, 'own-agent.json'), 'utf8');
}

it('keeps a key House accepts in the default Kit home, says so in one line and runs nothing, and a plain house then calls House with it', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const container = await freshContainer();

  const kit = runKit(['chatgpt', '--key', KEY, '--house', house.origin], container.environment);

  expect(await kit.exited).toBe(0);
  expect(kit.stdout()).toBe(`house now calls ${house.origin} as you, with the key kept in ${container.kitHome}.\n`);
  expect(kit.stderr()).toBe('');
  expect(await entriesUnder(container.home)).toEqual(['.house-kit', join('.house-kit', 'own-agent.json')]);
  expect(await ownAgent(container.kitHome)).toEqual({ house: house.origin, credential: KEY });
  expect(await entriesUnder(container.ran)).toEqual([]);
  expect(calls(house)).toEqual([[`Bearer ${KEY}`, 'tools/list']]);

  expect(await inContainer(container, 'house list_rooms')).toEqual({ status: 0, stdout: 'room_ref: r_one\n', stderr: '' });
  expect(calls(house)).toEqual([
    [`Bearer ${KEY}`, 'tools/list'],
    [`Bearer ${KEY}`, 'tools/call'],
  ]);
});

it('checks a new key with the House the Kit home already names when no --house is passed, and keeps it in place of the earlier key', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const container = await freshContainer();
  await holdEarlierKey(container, house);

  const kit = runKit(['chatgpt', '--key', KEY], container.environment);

  expect(await kit.exited).toBe(0);
  expect(calls(house)).toEqual([[`Bearer ${KEY}`, 'tools/list']]);
  expect(await ownAgent(container.kitHome)).toEqual({ house: house.origin, credential: KEY });
  expect(await entriesUnder(container.ran)).toEqual([]);
});

it('refuses a key House does not accept and writes nothing', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const container = await freshContainer();

  const kit = runKit(['chatgpt', '--key', 'ahp_revoked', '--house', house.origin], container.environment);

  expect(await kit.exited).toBe(1);
  expect(kit.stdout()).toBe('');
  expect(kit.stderr()).toBe(`kit: ${house.origin} does not accept this key; pass one from New key for a script on Connections\n`);
  expect(await entriesUnder(container.home)).toEqual([]);
  expect(await entriesUnder(container.ran)).toEqual([]);
});

it('refuses a key House does not accept and keeps the earlier key the Kit home holds', async () => {
  const house = await startHouse(certificate());
  serveKey(house);
  const container = await freshContainer();
  const earlier = await holdEarlierKey(container, house);

  const kit = runKit(['chatgpt', '--key', 'ahp_revoked'], container.environment);

  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toBe(`kit: ${house.origin} does not accept this key; pass one from New key for a script on Connections\n`);
  expect(await entriesUnder(container.home)).toEqual(['.house-kit', join('.house-kit', 'own-agent.json')]);
  expect(await readFile(join(container.kitHome, 'own-agent.json'), 'utf8')).toBe(earlier);
  expect(await entriesUnder(container.ran)).toEqual([]);
});

it.each([[[]], [['--house', 'https://dev.agents.house']]])('refuses kit chatgpt %j without a key, asking House nothing and writing nothing', async (argv) => {
  const container = await freshContainer();

  const kit = runKit(['chatgpt', ...argv], container.environment);

  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toBe('kit: pass --key with a key from New key for a script on Connections\n');
  expect(await entriesUnder(container.home)).toEqual([]);
  expect(await entriesUnder(container.ran)).toEqual([]);
});
