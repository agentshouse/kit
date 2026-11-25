import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills } from '@agentshouse/skills';
import { expect, it } from 'vitest';
import { catalogue, serveCatalogue } from './catalogue.ts';
import { settle, startHouse, until } from './double.ts';
import { hostKit } from './environment.ts';
import { accountOf, runKit, temporaryHome } from './kit.ts';
import { logIn, serveLogin } from './login.ts';
import { house as houseRun, serveRooms } from './rooms.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));

const KIT_RELEASE = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

async function absent(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function runHouse(home: string, argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: accountOf(home) };
    delete environment.HOUSE_BRIDGE;
    const child = spawn(process.execPath, [HOUSE, ...argv], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

it('connects its Environment with the credential an earlier Kit wrote, straight to House when it names no relay', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), `{"house":"${house.origin}","environment":"environment-one","credential":"ahk_held"}\n`);

  runKit(['resident'], { HOME: accountOf(home) });

  expect((await until(() => house.connections[0])).headers.authorization).toBe('Bearer ahk_held');
});

it('reconnects the Environment an earlier Kit recorded when it was disconnected', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'disconnected.json'), `{"house":"${house.origin}","environment":"environment-one"}\n`);
  serveLogin(house, 'environment-one', 'ahk_again');

  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'existing_environment', environment_id: 'environment-one' });
});

it('places no skill when the configuration an earlier Kit wrote declines the Skill set, and places all when none is written', async () => {
  const house = await startHouse();
  serveCatalogue(house, listSkills().map(({ name }) => name));
  const declined = await temporaryHome();
  await writeFile(join(declined, 'kit.json'), '{"skills":false}\n');
  const unwritten = await temporaryHome();

  for (const home of [declined, unwritten]) {
    serveLogin(house, 'environment-one', 'ahk_first');
    expect((await logIn(house, home)).exit).toBe(0);
  }

  await absent(join(declined, '.agents', 'skills'));
  expect(JSON.parse(await readFile(join(unwritten, 'skill-set.json'), 'utf8'))).toMatchObject({ version: KIT_RELEASE });
});

it('calls House outside a conversation under the Kit credential an earlier Kit wrote', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), `{"house":"${house.origin}","environment":"environment-one","credential":"ahk_earlier"}\n`);
  house.route('POST', '/', ({ body }) => ({
    body: { jsonrpc: '2.0', id: (body as { id: string }).id, result: { content: [{ type: 'text', text: 'found' }] } },
  }));

  expect(await runHouse(home, ['search', '{"query":"invoice"}'])).toMatchObject({ status: 0, stdout: 'found\n' });

  expect(house.requests[0]!.headers.authorization).toBe('Bearer ahk_earlier');
});

it('returns the Result of a call an earlier Kit kept, without carrying the call out again', async () => {
  const hosted = await hostKit([], {
    prepare: (home) => writeFile(join(home, 'call-results.json'), '{"call-kept":{"exit_code":0,"output":"kept\\n","cut":false}}'),
  });

  hosted.call({
    input_id: 'call-kept',
    kind: 'run_function',
    conversation_id: null,
    agent_id: null,
    script: 'echo carried out again',
    input: null,
    terminal: false,
    time_cap: 60,
    output_cap: 65_536,
  });

  expect(await hosted.result('call-kept')).toEqual({ exit_code: 0, output: 'kept\n', cut: false });
});

it.each([
  ['as it placed one', `{"version":"0.2.1-c000000000001","origin":"https://agents.house","names":["retired"]}\n`],
  ['before it placed one', '{"names":["retired"]}\n'],
])('replaces the skills the Skill set record an earlier Kit wrote %s names', async (_, record) => {
  const hosted = await hostKit([{}], {
    skills: 'all',
    tools: { guide: catalogue(listSkills().map(({ name }) => name)) },
    prepare: async (home) => {
      await writeFile(join(home, 'skill-set.json'), record);
      await mkdir(join(accountOf(home), '.agents', 'skills', 'retired'), { recursive: true });
    },
  });

  await until(async () => (JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8')) as { digest?: string }).digest);
  await absent(join(accountOf(hosted.home), '.agents', 'skills', 'retired'));
  expect(JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8'))).toMatchObject({ version: KIT_RELEASE, origin: hosted.house.origin });
});

it("catches a Local copy up from the position its record keeps, reading the Room no other way, and reads a field a later Kit added with no harm", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  await rooms.download([notes]);
  const path = join(hosted.home, 'local-copies', 'rooms', `${notes.ref}.json`);
  const kept = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(kept).sort()).toEqual(['key', 'log_epoch', 'position', 'protected', 'repository', 'room_handle', 'room_ref', 'write']);
  await writeFile(path, JSON.stringify({ ...kept, added_later: { by: 'a later Kit' } }));
  await hosted.restart();
  const asked = hosted.house.requests.length;
  notes.put('b.md', 'b, from House\n');

  expect(await houseRun(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: '/rooms/notes: 1 file updated from House\n' });

  await settle();
  const read = hosted.house.requests.slice(asked).filter((request) => request.path.startsWith('/kit/door/'));
  expect(read.map((request) => [request.path, request.body])).toEqual([
    ['/kit/door/rooms/discover', expect.anything()],
    ['/kit/door/changes/enumerate', { prefixes: [notes.root], positions: [{ authority: notes.ref, position: String(kept.position), log_epoch: kept.log_epoch }] }],
  ]);
});

it("reports the waiting Runs of a wait record an earlier Kit kept at its start, and waits on a Run by a name an earlier Kit kept", async () => {
  const [conversation, run] = ['019a0000-0000-7000-8000-0000000000c1', '019a0000-0000-7000-8000-000000000001'];
  const hosted = await hostKit([], {
    prepare: async (home) => {
      await mkdir(join(home, 'run-waits'), { recursive: true });
      await writeFile(join(home, 'run-waits', '019a0000-0000-7000-8000-0000000000d1.json'), `{"conversation_id":"${conversation}","runs":["${run}"]}\n`);
      await writeFile(join(home, 'run-names.json'), `[{"name":"rev-1","run":"${run}"}]\n`);
    },
  });

  const report = await until(() => hosted.house.requests.find((request) => request.path === '/kit/kits/report-restart'));
  expect(report.body).toEqual({ waits: [{ conversation_id: conversation, runs: [run] }] });
  const command = runHouse(hosted.home, ['agent', 'run', '{"refs":["rev-1"]}']);
  const connection = hosted.house.connections.at(-1)!;
  await until(() => connection.oneWayCalls.find((oneWayCall) => oneWayCall.type === 'waiting' && JSON.stringify(oneWayCall.runs) === JSON.stringify([run])));
  connection.send({ type: 'run', run, state: 'idle', name: 'rev-1' });
  expect(await command).toEqual({ status: 0, stdout: `rev-1 ${run} idle\n`, stderr: '' });
  await until(() => access(join(hosted.home, 'run-waits', '019a0000-0000-7000-8000-0000000000d1.json')).then(() => false, () => true));
});
