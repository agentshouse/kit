import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { settle, startHouse, until } from './double.ts';
import { hostKit } from './environment.ts';
import { fakeHost } from './host.ts';
import { runKit, temporaryHome } from './kit.ts';
import { logIn, serveLogin } from './login.ts';
import { house as houseFetch, serveRooms } from './rooms.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));

const KIT_RELEASE = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

async function absent(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function runHouse(home: string, argv: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOUSE_KIT_HOME: home };
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

  runKit(['resident'], { HOUSE_KIT_HOME: home });

  expect((await until(() => house.connections[0])).headers.authorization).toBe('Bearer ahk_held');
});

it("reads the placement and the Environment an earlier Kit recorded in its installer, the credential's Environment beside a field a later Kit adds", async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64' });
  expect(host.run()).toMatchObject({ status: 0 });
  const kitHome = join(host.home, '.house-kit');
  await writeFile(join(kitHome, 'placement'), 'container\n');
  await writeFile(
    join(kitHome, 'credential.json'),
    '{"house":"https://agents.house","environment":"environment-two","credential":"ahk_one","later":"a field a later Kit adds"}\n',
  );

  const ran = host.run();

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain('a Kit process runs in a container on this computer for Environment environment-two;');
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

it('places no Skill set when the configuration an earlier Kit wrote declines it, and places it when none is written', async () => {
  const house = await startHouse();
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

it("calls House outside a conversation with the User's own agent's connection an earlier Kit wrote", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), `{"house":"${house.origin}","user":"user-one","credential":"ahp_own"}\n`);
  house.route('POST', '/', ({ body }) => ({
    body: { jsonrpc: '2.0', id: (body as { id: string }).id, result: { content: [{ type: 'text', text: 'found' }] } },
  }));

  expect(await runHouse(home, ['search', '{"query":"invoice"}'])).toMatchObject({ status: 0, stdout: 'found\n' });

  expect(house.requests[0]!.headers.authorization).toBe('Bearer ahp_own');
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
    skills: true,
    prepare: async (home) => {
      await writeFile(join(home, 'skill-set.json'), record);
      await mkdir(join(home, '.agents', 'skills', 'retired'), { recursive: true });
    },
  });

  await absent(join(hosted.home, '.agents', 'skills', 'retired'));
  expect(JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8'))).toMatchObject({ version: KIT_RELEASE, origin: hosted.house.origin });
});

it("catches a Local copy up from the position the record an earlier Kit wrote keeps, reading the Room no other way", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  await rooms.fetch([notes]);
  const path = join(hosted.home, 'local-copies', 'rooms', `${notes.ref}.json`);
  const kept = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(
    path,
    JSON.stringify({
      key: kept.key,
      room_ref: kept.room_ref,
      room_handle: kept.room_handle,
      repository: kept.repository,
      house: kept.house,
      position: kept.position,
      log_epoch: kept.log_epoch,
      write: kept.write,
      protected: kept.protected,
      read_only: kept.read_only,
      manifests: kept.manifests,
      moves: kept.moves,
    }),
  );
  await hosted.restart();
  const asked = hosted.house.requests.length;
  notes.put('b.md', 'b, from House\n');

  expect(await houseFetch(hosted, '/', 'fetch')).toMatchObject({ status: 0 });

  await settle();
  const read = hosted.house.requests.slice(asked).filter((request) => request.path.startsWith('/kit/door/'));
  expect(read.map((request) => [request.path, request.body])).toEqual([
    ['/kit/door/rooms/discover', expect.anything()],
    ['/kit/door/changes/enumerate', { prefixes: [notes.root], positions: [{ authority: notes.ref, position: String(kept.position), log_epoch: kept.log_epoch }] }],
  ]);
});
