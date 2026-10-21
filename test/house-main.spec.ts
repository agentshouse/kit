import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, open, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ownerSocket } from '../src/home.ts';
import { startHouse, type House } from './double.ts';
import { helpLine, LISTING, shelled, type McpCall } from './environment.ts';
import { runKit, temporaryHome } from './kit.ts';
import { RELAYED, startStore, uploadTool, type Store } from './store.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
const MEMORY = fileURLToPath(new URL('./memory.ts', import.meta.url));
const FAST_TIMEOUTS = fileURLToPath(new URL('./fast-timeouts.ts', import.meta.url));

function runHouse(
  home: string,
  argv: string[],
  bridge?: string,
  node: string[] = [],
  ambient: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOUSE_KIT_HOME: home, ...ambient };
    delete environment.HOUSE_BRIDGE;
    if (bridge !== undefined) environment.HOUSE_BRIDGE = bridge;
    const child = spawn(process.execPath, [...node, HOUSE, ...argv], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function connected(house: House, own: boolean): Promise<string> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  if (own) await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_own' }));
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const result = message.method === 'tools/list' ? { tools: LISTING } : shelled(`found for ${String(message.params.arguments?.query)}`);
    return { body: { jsonrpc: '2.0', id: message.id, result } };
  });
  return home;
}

it("sends a Tool call outside a conversation to House's root under the User's own agent's connection and prints House's answer", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran).toEqual({ status: 0, stdout: 'found for invoice\n', stderr: '' });
  const [call] = house.requests;
  expect(call).toMatchObject({ path: '/', headers: { authorization: 'Bearer ahp_own' } });
  expect((call!.body as McpCall).params).toMatchObject({ name: 'search', arguments: { query: 'invoice' } });
});

function zeros(size: number): string {
  const digest = createHash('sha256');
  const mebibyte = Buffer.alloc(1024 * 1024);
  for (let held = 0; held < size; held += mebibyte.length) digest.update(mebibyte);
  return digest.digest('hex');
}

function servedUploads(house: House, store: Store, partBytes: number, checks = 0) {
  const uploads = uploadTool(store, partBytes, { checks });
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: await uploads.answer(message.params.arguments!) } };
  });
  return uploads;
}

async function relay(): Promise<{ origin: string; forwarded: string[] }> {
  const forwarded: string[] = [];
  const server = createHttpServer((request, response) => {
    const [, host, path] = /^\/([^/]+)(\/.*)$/.exec(request.url ?? '')!;
    forwarded.push(`${request.method} ${host}`);
    const outbound = httpRequest(`http://${host}${path}`, { method: request.method, headers: { ...request.headers, host, [RELAYED]: 'true' } }, (answer) => {
      response.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(response);
    });
    outbound.on('error', () => response.destroy());
    request.pipe(outbound);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, forwarded };
}

it("uploads a file larger than the house CLI's memory budget from disk in parts outside a conversation, its peak memory under half the file's size, and prints House's answer once House accepts it", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const store = await startStore();
  const uploads = servedUploads(house, store, 32 * 1024 * 1024);
  const file = join(home, 'recording.webm');
  const size = 512 * 1024 * 1024;
  const held = await open(file, 'w');
  await held.truncate(size);
  await held.close();
  const peak = join(home, 'peak-memory');

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'recordings/recording.webm' })], undefined, [
    '--import',
    MEMORY,
  ], { KIT_TEST_PEAK_MEMORY: peak });

  expect(ran).toEqual({ status: 0, stdout: 'path: recordings/recording.webm\nrevision: fr_1\n', stderr: '' });
  expect(uploads.calls.declared).toEqual([
    {
      room_ref: 'r_room',
      path: 'recordings/recording.webm',
      bytes: size,
      sha256: zeros(size),
      media_type: 'video/webm',
    },
  ]);
  expect(store.requests.map((request) => [request.part, request.bytes, request.status])).toEqual(
    Array.from({ length: 16 }, (_part, index) => [index + 1, 32 * 1024 * 1024, 200]),
  );
  expect(Number(await readFile(peak, 'utf8'))).toBeLessThan(size / 2);
});

it('finishes the upload again while House answers that it is still checking the stored bytes, and prints the accepted file', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const store = await startStore();
  const uploads = servedUploads(house, store, 64, 2);
  const file = join(home, 'cover.bin');
  await writeFile(file, Buffer.from([0, 1, 2, 255]));

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 0, stdout: 'path: covers/cover.bin\nrevision: fr_1\n', stderr: '' });
  expect(uploads.calls.finished).toEqual(Array(3).fill({ upload: expect.any(String), room_ref: 'r_room' }));
});

it('gives up an upload whose store keeps refusing every part, saying so without the address, once eight rounds sent nothing', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const store = await startStore();
  const uploads = servedUploads(house, store, 64);
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    const answered = await uploads.answer(message.params.arguments!);
    const text = answered.content[0]!.text.replace(/signature=[0-9a-f]+/g, 'signature=altered');
    return { body: { jsonrpc: '2.0', id: message.id, result: { ...answered, content: [{ type: 'text', text }] } } };
  });
  const file = join(home, 'cover.bin');
  await writeFile(file, Buffer.from([0, 1, 2, 255]));

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: 'house: the upload answered 403; upload the file again\n' });
  expect(store.requests.map((request) => request.status)).toEqual(Array(8).fill(403));
  expect(uploads.calls.finished).toHaveLength(7);
});

it("resumes an upload outside a conversation after its connection drops, finishing again until House answers and sending only the part the store lost", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const store = await startStore();
  const uploads = uploadTool(store, 3);
  let finishing = 0;
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    if (message.params.arguments!.upload !== undefined && ++finishing <= 2) return { drop: true };
    return { body: { jsonrpc: '2.0', id: message.id, result: await uploads.answer(message.params.arguments!) } };
  });
  store.cut(2);
  const file = join(home, 'cover.bin');
  await writeFile(file, Buffer.from([0, 1, 2, 255]));

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 0, stdout: 'path: covers/cover.bin\nrevision: fr_1\n', stderr: '' });
  expect(store.requests.map((request) => [request.part, request.status])).toEqual([
    [1, 200],
    [2, 0],
    [2, 200],
  ]);
  expect(finishing).toBe(4);
});

it('finishes an upload outside a conversation again while House answers it with a 503, as a conversation resends an unsettled call', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const store = await startStore();
  const uploads = uploadTool(store, 3);
  let finishing = 0;
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    if (message.params.arguments!.upload !== undefined && ++finishing <= 2) return { status: 503, body: {} };
    return { body: { jsonrpc: '2.0', id: message.id, result: await uploads.answer(message.params.arguments!) } };
  });
  const file = join(home, 'cover.bin');
  await writeFile(file, Buffer.from([0, 1, 2, 255]));

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 0, stdout: 'path: covers/cover.bin\nrevision: fr_1\n', stderr: '' });
  expect(store.requests.map((request) => [request.part, request.status])).toEqual([
    [1, 200],
    [2, 200],
  ]);
  expect(finishing).toBe(3);
});

it('sends each part and reads each download at its store address through the Kit relay its User named, as it sends House its calls', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const store = await startStore();
  const uploads = servedUploads(house, store, 3);
  const content = Buffer.from([0, 1, 2, 255]);
  const file = join(home, 'cover.bin');
  await writeFile(file, content);
  const { origin, forwarded } = await relay();
  const relayed = { HOUSE_KIT_RELAY: origin };

  const sent = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'covers/cover.bin' })], undefined, [], relayed);
  store.objects.set('binary/cover', content);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const inspected = `sha256: ${createHash('sha256').update(content).digest('hex')}\ndownload: ${store.address('GET', 'binary/cover')}`;
    return { body: { jsonrpc: '2.0', id: message.id, result: shelled(inspected) } };
  });
  const fetched = await runHouse(home, ['download', JSON.stringify({ path: '/rooms/room/covers/cover.bin', file: join(home, 'back.bin') })], undefined, [], relayed);

  expect([sent.status, fetched.status]).toEqual([0, 0]);
  expect(await readFile(join(home, 'back.bin'))).toEqual(content);
  expect(uploads.calls.finished).toHaveLength(1);
  const [houseHost, storeHost] = [new URL(house.origin).host, new URL(store.origin).host];
  expect(forwarded).toEqual([
    `POST ${houseHost}`,
    `PUT ${storeHost}`,
    `PUT ${storeHost}`,
    `POST ${houseHost}`,
    `POST ${houseHost}`,
    `GET ${storeHost}`,
  ]);
  expect(store.requests.map((request) => [request.method, request.relayed])).toEqual([
    ['PUT', true],
    ['PUT', true],
    ['GET', true],
  ]);
});

it('prints the revision House answers and posts no bytes when the path already holds the same file', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const file = join(home, 'cover.png');
  await writeFile(file, 'png');
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: shelled('path: covers/cover.png\nrevision: fr_1') } };
  });

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, room_ref: 'r_room', path: 'covers/cover.png' })]);

  expect(ran).toEqual({ status: 0, stdout: 'path: covers/cover.png\nrevision: fr_1\n', stderr: '' });
  expect(house.requests.map((request) => request.path)).toEqual(['/']);
  expect((house.requests[0]!.body as McpCall).params.arguments).toMatchObject({ media_type: 'image/png' });
});

it("lists the Tools House lists to the User's own agent as its help, and never sends the Kit credential", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['--help']);

  expect(ran.status).toBe(0);
  for (const tool of LISTING) expect(ran.stdout).toContain(helpLine(tool));
  expect(house.requests.map((request) => request.headers.authorization)).toEqual(['Bearer ahp_own']);
});

it('says a write may have taken effect when House answers with no result, and to read before repeating it', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/', () => ({ status: 502, bytes: { type: 'text/html', content: '<html>Bad Gateway</html>' } }));

  const ran = await runHouse(home, ['edit', '{"changes":[]}']);

  expect(ran).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: House answered 502 with no result; a write may or may not have taken effect, so read before you repeat it\n',
  });
});

it.each([
  ['the gateway in front of House', { 'content-type': 'application/json' }, 'Bad Gateway', `House answered 502 with no result; a write may or may not have taken effect, so read before you repeat it`],
  ['the bridge itself', {}, 'House is unreachable; call again in a minute', 'House is unreachable; call again in a minute'],
])("prints a bridged 502 from %s as that answer says", async (_from, headers: Record<string, string>, body, said) => {
  const home = await temporaryHome();
  const socket = join(home, 'bridge.sock');
  const bridge = createHttpServer((request, response) => {
    request.resume();
    response.writeHead(502, headers).end(body);
  });
  bridge.listen(socket);
  await once(bridge, 'listening');
  onTestFinished(() => new Promise<void>((resolve) => bridge.close(() => resolve())));

  const ran = await runHouse(home, ['--help'], socket);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: `house: ${said}\n` });
});

it("refuses a Tool call in one line naming kit login while Kit holds no connection for the User's own agent", async () => {
  const house = await startHouse();
  const home = await connected(house, false);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe('');
  expect(ran.stderr).toMatch(/^house: [^\n]*kit login, or kit chatgpt --key <key>[^\n]*\n$/);
  expect(house.requests).toEqual([]);
});

it("refuses a Tool call naming kit login once kit logout has ended the User's own agent's connection with the Kit's", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/kit/logout', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOUSE_KIT_HOME: home }).exited).toBe(0);
  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(house.requests.map(({ path, headers, body }) => ({ path, authorization: headers.authorization, body }))).toEqual([
    { path: '/kit/logout', authorization: 'Bearer ahk_kit', body: {} },
  ]);
  await expect(access(join(home, 'own-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(ran.status).toBe(1);
  expect(ran.stderr).toMatch(/^house: [^\n]*kit login, or kit chatgpt --key <key>[^\n]*\n$/);
});

it("stops acting as the User when House had already disconnected the computer", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/kit/logout', () => ({ status: 401, body: { error: { code: 'kit_credential_rejected' } } }));

  const logout = runKit(['logout'], { HOUSE_KIT_HOME: home });

  expect(await logout.exited).toBe(0);
  expect(logout.stdout()).toBe('Environment environment-one is disconnected; kit login reconnects it.\n');
  await expect(access(join(home, 'own-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await runHouse(home, ['search', '{"query":"invoice"}'])).stderr).toMatch(/kit login/);
});

it("never falls back to the User's own agent's connection when a conversation's bridge is gone", async () => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}'], join(home, 'bridges', 'gone.sock'));

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe("house: this conversation's House connection is closed; nothing to do from here\n");
  expect(house.requests).toEqual([]);
});

it('tells an Agent whose CLI sandbox refuses the bridge to run house directly', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  const socket = join(home, 'sandboxed.sock');
  const bridge = createServer((connection) => connection.end());
  bridge.listen(socket);
  await once(bridge, 'listening');
  await chmod(socket, 0);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}'], socket);
  bridge.close();

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe(
    "house: your CLI's sandbox kept house from House; run house directly, not through another program\n",
  );
  expect(house.requests).toEqual([]);
});

it('prints the same help for house help as for house --help, listing help, push, fetch and download, a Tool without a description by its name alone, and no Git verb', async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: { tools: [...LISTING, { name: 'about_house', inputSchema: { type: 'object' } }] } } };
  });

  const help = await runHouse(home, ['help']);
  const dashed = await runHouse(home, ['--help']);

  expect(help).toEqual(dashed);
  expect(help.status).toBe(0);
  const lines = help.stdout.split('\n');
  expect(lines.slice(0, 5)).toEqual([
    "usage: house <tool> ['<arguments as JSON>']",
    'help',
    "push [commit]: sends the Local copy's committed changes to House",
    "fetch: records House's changes on each Local copy's refs/house/received",
    'download: writes a binary file of a Room to the local file named by file',
  ]);
  expect(lines).toContain('about_house');
  expect(help.stdout).not.toMatch(/\bgit\b/);
  expect((await runHouse(home, ['about_house', '--help'])).stdout).toBe('{"type":"object"}\n');
});

it.each([
  [['edit', '{"changes":[{"op":"create","path":"/rooms/notes/new.md","content":"new"}]}', '--help'], '--help'],
  [['list_rooms', '{}', '--bogus'], '--bogus'],
  [['--version'], '--version'],
])('refuses house %j with its usage before it calls House', async (argv, unexpected) => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, argv);

  expect(ran).toEqual({
    status: 1,
    stdout: '',
    stderr: `house: unexpected argument ${unexpected}; usage: house <tool> ['<arguments as JSON>']\n`,
  });
  expect(house.requests).toEqual([]);
});

it.each([
  [['--help', 'push'], 'usage: house push [commit] [--owner]'],
  [['--help', 'push', 'HEAD', '--owner'], 'usage: house push [commit] [--owner]'],
  [['--help', 'fetch'], 'usage: house fetch'],
  [['download', '--help'], `usage: house download '{"path":"/rooms/<handle>/<path>","file":"<local file>"}', adding "ref" for a revision`],
])('prints house %j as the usage of the command it names and calls nothing', async (argv, usage) => {
  const house = await startHouse();
  const home = await connected(house, true);

  const ran = await runHouse(home, argv);

  expect(ran).toEqual({ status: 0, stdout: `${usage}\n`, stderr: '' });
  expect(house.requests).toEqual([]);
});

it.each([
  [['push', '--dry-run'], true, '--dry-run', 'usage: house push [commit] [--owner]'],
  [['push', '--owner', '--dry-run'], false, '--dry-run', 'usage: house push [commit] [--owner]'],
  [['push', 'HEAD', '--owner', '--dry-run'], false, '--dry-run', 'usage: house push [commit] [--owner]'],
  [['fetch', '--x'], false, '--x', 'usage: house fetch'],
])('refuses house %j with its usage before it opens a Kit connection', async (argv, conversation, unexpected, usage) => {
  const home = await temporaryHome();
  vi.stubEnv('HOUSE_KIT_HOME', home);
  const owner = ownerSocket();
  vi.unstubAllEnvs();
  const opened: string[] = [];
  for (const socket of [owner, join(home, 'bridge.sock')]) {
    const listener = createServer((connection) => {
      opened.push(socket);
      connection.destroy();
    });
    listener.listen(socket);
    await once(listener, 'listening');
    onTestFinished(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  }

  const ran = await runHouse(home, argv, conversation ? join(home, 'bridge.sock') : undefined);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: `house: unexpected argument ${unexpected}; ${usage}\n` });
  expect(opened).toEqual([]);
});

it("exits with the status House's shell answer names, and 0 when it names none", async () => {
  const house = await startHouse();
  const home = await connected(house, true);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const failed = message.params.arguments?.command === 'ls /rooms/private/house';
    return { body: { jsonrpc: '2.0', id: message.id, result: failed ? shelled('', 2, ['ls: path_not_found /rooms/private/house']) : shelled('ROOM.md') } };
  });

  const failed = await runHouse(home, ['shell', '{"command":"ls /rooms/private/house"}']);
  const listed = await runHouse(home, ['shell', '{"command":"ls /rooms/private"}']);

  expect(failed).toEqual({ status: 2, stdout: 'exit: 2\nstderr: ls: path_not_found /rooms/private/house\n', stderr: '' });
  expect(listed).toEqual({ status: 0, stdout: 'ROOM.md\n', stderr: '' });
});
