import { CONVERSATION_META_KEY, FUNCTION_RUN_META_KEY, KIT_WIRE, KIT_WIRE_HEADER } from '@agentshouse/kit-wire';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, open, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ownerSocket } from '../src/home.ts';
import { startHouse, type House } from './double.ts';
import { shelled, type McpCall } from './environment.ts';
import { HELP_META, LISTING, listed } from './listing.ts';
import { accountOf, runKit, temporaryHome } from './kit.ts';
import { startRelay, type Relay } from './relay-double.ts';
import { startStore, uploadTool, type Store } from './store.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
const MEMORY = fileURLToPath(new URL('./memory.ts', import.meta.url));
const FAST_TIMEOUTS = fileURLToPath(new URL('./fast-timeouts.ts', import.meta.url));
const USAGE = "usage: house <tool> ['<arguments as JSON>'], or house <tool> - to read them from stdin; house help <tool>: its arguments or its ops; house help <tool> <op>: an op's arguments";
const ARGUMENTS = 'the arguments are one JSON object, in single quotes or on stdin after -';
const LONG = '`true` raises the limit of a cut answer from 2 KB to 100 KB.';
const UPLOAD =
  "upload: in a Room's Local copy, sends at once every file changed, added or deleted there since it last matched House, each .md file as document text and every other file as an attachment, as Kit's next save would; with JSON, sends one local file to the Room path it names, or with no file prints the link where your User picks the files for that folder";
const UPLOAD_USAGE = `usage: house upload, house upload '{"file":"<local file>","path":"rooms/<handle>/<path>"}', adding "base", the revision it replaces, or house upload '{"path":"rooms/<handle>/<folder>"}' for the link where your User picks the files`;
const DOWNLOAD =
  "download: brings House's changes into every Room's Local copy at once, or, run in a conversation's copy, into that copy alone, leaving each file changed here for the next save to merge; a copy holds the Room's documents and only the attachments asked for there, a conversation's copy linking each one already on this computer, and a download brings no attachment nobody asked for and brings each one the copy holds that another writer changed at its new revision, linked where this computer holds it; --with-attachments brings each attachment the copy lacks up to --max-size megabytes, 10 by default; with JSON, writes one attachment of a Room to the local file named by file";
const KIT_VERBS = [
  'login: connects this computer to House as an Environment, by a link you confirm or a login code',
  'logout: disconnects this computer and stops the Kit process',
  "connect: connects this computer, keeping the Environment it has, and starts Kit's service; the install runs it",
  "resident: keeps this Environment connected; Kit's service runs it",
  "settings: prints Kit's settings, or changes which skills Kit installs or where its workspace is",
  "git-credential: answers git with this computer's House credential; git runs it",
];
const AGENT_RUN_USAGE = `usage: house agent run '{"runs":[{"room":"<handle>","agent_function":"<card>","payload":"<brief>"}]}', each Run with agent_update request_send's arguments, or house agent run '{"refs":["<Run reference or name>"]}' to wait again; - reads them from stdin`;
const AGENT_RUN =
  'agent run: starts each of "runs" by agent_update request_send, prints its name and reference, and waits until every Run is idle, failed, not started, declined, withdrawn or deleted, printing each one\'s state and never its message; exits 0 only when every Run is idle; with "refs" it starts nothing and waits again';
const DOWNLOAD_USAGE = `usage: house download [--with-attachments] [--max-size <MB>], or house download '{"path":"rooms/<handle>/<path>","file":"<local file>"}', adding "ref" for a revision`;

function runHouse(
  home: string,
  argv: string[],
  bridge?: string,
  node: string[] = [],
  ambient: Record<string, string> = {},
  input = '',
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: accountOf(home), ...ambient };
    delete environment.HOUSE_BRIDGE;
    if (bridge !== undefined) environment.HOUSE_BRIDGE = bridge;
    const child = spawn(process.execPath, [...node, HOUSE, ...argv], { env: environment });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function connected(house: House, enrolled = true): Promise<string> {
  const home = await temporaryHome();
  if (enrolled) await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const result = message.method === 'tools/list' ? listed(message.params) : shelled(`found for ${String(message.params.arguments?.query)}`);
    return { body: { jsonrpc: '2.0', id: message.id, result } };
  });
  return home;
}

it("sends a Tool call outside a conversation to House's root under the Kit credential, naming nothing, with an operation id, and prints House's answer", async () => {
  const house = await startHouse();
  const home = await connected(house);
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_own' }));

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran).toEqual({ status: 0, stdout: 'found for invoice\n', stderr: '' });
  const [call] = house.requests;
  expect(call).toMatchObject({ path: '/', headers: { authorization: 'Bearer ahk_kit' } });
  const { params } = call!.body as McpCall;
  expect(params).toMatchObject({ name: 'search', arguments: { query: 'invoice' } });
  expect(params.arguments).toEqual({ query: 'invoice' });
  expect(params._meta['agents.house/agent-operation']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(params._meta).not.toHaveProperty(CONVERSATION_META_KEY);
  expect(params._meta).not.toHaveProperty(FUNCTION_RUN_META_KEY);
});

it("reads a Tool's arguments from stdin after -, so an update larger than one Linux argument holds reaches House whole", async () => {
  const house = await startHouse();
  const home = await connected(house);
  house.route('POST', '/', ({ body }) => ({ body: { jsonrpc: '2.0', id: (body as { id: string }).id, result: shelled('applied') } }));
  const changes = [{ op: 'write', path: 'rooms/notebook/long.md', content: 'line\n'.repeat(1024 * 1024 / 5) }];
  const piped = JSON.stringify({ changes });
  expect(Buffer.byteLength(piped)).toBeGreaterThan(1024 * 1024);

  const ran = await runHouse(home, ['update', '-'], undefined, [], {}, piped);

  expect(ran).toEqual({ status: 0, stdout: 'applied\n', stderr: '' });
  expect((house.requests[0]!.body as McpCall).params).toMatchObject({ name: 'update', arguments: { changes } });
});

it("names the Kit's wire in a header on its call to House's MCP door", async () => {
  const house = await startHouse();
  const home = await connected(house);

  await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(house.requests.map((request) => request.headers[KIT_WIRE_HEADER])).toEqual([KIT_WIRE]);
});

function zeros(size: number): string {
  const digest = createHash('sha256');
  const mebibyte = Buffer.alloc(1024 * 1024);
  for (let held = 0; held < size; held += mebibyte.length) digest.update(mebibyte);
  return digest.digest('hex');
}

function servedUploads(house: House, store: Store, partBytes: number) {
  const uploads = uploadTool(store, partBytes);
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: await uploads.answer(message.params.arguments!) } };
  });
  return uploads;
}

function forwarded(relay: Relay): string[] {
  return relay.requests.map((request) => `${request.method} ${request.host}`);
}

it("uploads a file larger than the house CLI's memory budget from disk in parts outside a conversation, its peak memory under half the file's size, and prints House's answer once House accepts it", async () => {
  const house = await startHouse();
  const home = await connected(house);
  const store = await startStore();
  const uploads = servedUploads(house, store, 32 * 1024 * 1024);
  const file = join(home, 'recording.webm');
  const size = 512 * 1024 * 1024;
  const held = await open(file, 'w');
  await held.truncate(size);
  await held.close();
  const peak = join(home, 'peak-memory');

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/recordings/recording.webm' })], undefined, [
    '--import',
    MEMORY,
  ], { KIT_TEST_PEAK_MEMORY: peak });

  expect(ran).toEqual({ status: 0, stdout: 'path: rooms/room/recordings/recording.webm\nrevision: v_1.1.x\n', stderr: '' });
  expect(uploads.calls.declared).toEqual([
    {
      path: 'rooms/room/recordings/recording.webm',
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

it("names every part's SHA-256 and the file's path in each finishing call and sends each part with its checksum header, and prints the accepted file", async () => {
  const house = await startHouse();
  const home = await connected(house);
  const store = await startStore();
  const uploads = servedUploads(house, store, 10);
  const content = Buffer.from('a file sent in three parts');
  const digests = [content.subarray(0, 10), content.subarray(10, 20), content.subarray(20)].map((part) => createHash('sha256').update(part).digest());
  const [one, two, three] = digests.map((digest) => digest.toString('base64'));
  store.cut(2);
  const file = join(home, 'notes.bin');
  await writeFile(file, content);

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/notes/notes.bin' })]);

  expect(ran).toEqual({ status: 0, stdout: 'path: rooms/room/notes/notes.bin\nrevision: v_1.1.x\n', stderr: '' });
  expect(uploads.calls.finished).toEqual(
    Array(3).fill({ upload: expect.any(String), path: 'rooms/room/notes/notes.bin', part_sha256: digests.map((digest) => digest.toString('hex')) }),
  );
  expect(store.requests.map((request) => [request.part, request.checksum, request.bytes, request.status])).toEqual([
    [1, one, 10, 200],
    [2, two, 0, 0],
    [2, two, 10, 200],
    [3, three, 6, 200],
  ]);
});

it('gives up an upload whose store keeps refusing every part, saying so without the address, once eight rounds sent nothing', async () => {
  const house = await startHouse();
  const home = await connected(house);
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

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: 'house: the upload answered 403; upload the file again\n' });
  expect(store.requests.map((request) => request.status)).toEqual(Array(8).fill(403));
  expect(uploads.calls.finished).toHaveLength(8);
});

it("resumes an upload outside a conversation after its connection drops, finishing again until House answers and sending only the part the store lost", async () => {
  const house = await startHouse();
  const home = await connected(house);
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

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 0, stdout: 'path: rooms/room/covers/cover.bin\nrevision: v_1.1.x\n', stderr: '' });
  expect(store.requests.map((request) => [request.part, request.status])).toEqual([
    [1, 200],
    [2, 0],
    [2, 200],
  ]);
  expect(finishing).toBe(5);
});

it('finishes an upload outside a conversation again while House answers it with a 503, as a conversation resends an unsettled call, under the same operation id', async () => {
  const house = await startHouse();
  const home = await connected(house);
  const store = await startStore();
  const uploads = uploadTool(store, 3);
  let finishing = 0;
  const operations: unknown[] = [];
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    if (message.params.arguments!.upload !== undefined) operations.push(message.params._meta['agents.house/agent-operation']);
    if (message.params.arguments!.upload !== undefined && ++finishing <= 2) return { status: 503, body: {} };
    return { body: { jsonrpc: '2.0', id: message.id, result: await uploads.answer(message.params.arguments!) } };
  });
  const file = join(home, 'cover.bin');
  await writeFile(file, Buffer.from([0, 1, 2, 255]));

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/covers/cover.bin' })], undefined, [
    '--import',
    FAST_TIMEOUTS,
  ]);

  expect(ran).toEqual({ status: 0, stdout: 'path: rooms/room/covers/cover.bin\nrevision: v_1.1.x\n', stderr: '' });
  expect(store.requests.map((request) => [request.part, request.status])).toEqual([
    [1, 200],
    [2, 200],
  ]);
  expect(finishing).toBe(4);
  const [resent, again, answered, next] = operations;
  expect([again, answered]).toEqual([resent, resent]);
  expect(next).not.toBe(resent);
});

it('finishes an upload outside a conversation again only once the wait House names in its own refusal of the finishing call has passed', async () => {
  const house = await startHouse();
  const home = await connected(house);
  const store = await startStore();
  const uploads = uploadTool(store, 3);
  const finished: number[] = [];
  house.route('POST', '/', async ({ body }) => {
    const message = body as { id: string } & McpCall;
    if (message.params.arguments!.upload !== undefined && finished.push(Date.now()) === 1) {
      return {
        status: 429,
        headers: { 'Retry-After': '2' },
        body: { error: { code: 'rate_limited', retry_after: 2, retry_at: '2026-10-09T00:00:02.000Z', retryable: true } },
      };
    }
    return { body: { jsonrpc: '2.0', id: message.id, result: await uploads.answer(message.params.arguments!) } };
  });
  const file = join(home, 'cover.bin');
  await writeFile(file, Buffer.from([0, 1, 2, 255]));

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/covers/cover.bin' })]);

  expect(ran).toEqual({ status: 0, stdout: 'path: rooms/room/covers/cover.bin\nrevision: v_1.1.x\n', stderr: '' });
  expect(finished[1]! - finished[0]!).toBeGreaterThanOrEqual(2_000);
});

it('sends each part and reads each download at its store address through the Kit relay its User named, as it sends House its calls', async () => {
  const house = await startHouse();
  const home = await connected(house);
  const store = await startStore();
  const uploads = servedUploads(house, store, 3);
  const content = Buffer.from([0, 1, 2, 255]);
  const file = join(home, 'cover.bin');
  await writeFile(file, content);
  const relay = await startRelay();
  const relayed = { HOUSE_KIT_RELAY: relay.origin };

  const sent = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/covers/cover.bin' })], undefined, [], relayed);
  store.objects.set('binary/cover', content);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const details = `sha256: ${createHash('sha256').update(content).digest('hex')}\ndownload: ${store.address('GET', 'binary/cover')}`;
    return { body: { jsonrpc: '2.0', id: message.id, result: shelled(details) } };
  });
  const fetched = await runHouse(home, ['download', JSON.stringify({ path: 'rooms/room/covers/cover.bin', file: join(home, 'back.bin') })], undefined, [], relayed);

  expect([sent.status, fetched.status]).toEqual([0, 0]);
  expect(await readFile(join(home, 'back.bin'))).toEqual(content);
  expect(uploads.calls.finished).toHaveLength(2);
  const [houseHost, storeHost] = [new URL(house.origin).host, new URL(store.origin).host];
  expect(forwarded(relay)).toEqual([
    `POST ${houseHost}`,
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

it("calls House directly whatever relay the Kit credential's record holds, and through the relay HOUSE_KIT_RELAY names", async () => {
  const house = await startHouse();
  const home = await connected(house);
  const recorded = await startRelay();
  const named = await startRelay();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, relay: recorded.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  const direct = await runHouse(home, ['search', '{"query":"invoice"}']);
  const first = house.requests.length;

  const ambient = await runHouse(home, ['search', '{"query":"plans"}'], undefined, [], { HOUSE_KIT_RELAY: named.origin });

  expect([direct, ambient]).toEqual([
    { status: 0, stdout: 'found for invoice\n', stderr: '' },
    { status: 0, stdout: 'found for plans\n', stderr: '' },
  ]);
  const posted = `POST ${new URL(house.origin).host}`;
  expect(first).toBeGreaterThan(0);
  expect(forwarded(recorded)).toEqual([]);
  expect(forwarded(named)).toEqual(Array(house.requests.length - first).fill(posted));
});

it('prints the revision House answers and posts no bytes when the path already holds the same file', async () => {
  const house = await startHouse();
  const home = await connected(house);
  const file = join(home, 'cover.png');
  await writeFile(file, 'png');
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: shelled('path: rooms/room/covers/cover.png\nrevision: v_1.1.x') } };
  });

  const ran = await runHouse(home, ['upload', JSON.stringify({ file, path: 'rooms/room/covers/cover.png' })]);

  expect(ran).toEqual({ status: 0, stdout: 'path: rooms/room/covers/cover.png\nrevision: v_1.1.x\n', stderr: '' });
  expect(house.requests.map((request) => request.path)).toEqual(['/']);
  expect((house.requests[0]!.body as McpCall).params.arguments).toMatchObject({ media_type: 'image/png' });
});

it('says a write may have taken effect when House answers with no result, and to read before repeating it', async () => {
  const house = await startHouse();
  const home = await connected(house);
  house.route('POST', '/', () => ({ status: 502, bytes: { type: 'text/html', content: '<html>Bad Gateway</html>' } }));

  const ran = await runHouse(home, ['update', '{"changes":[{"op":"write","path":"rooms/notebook/new.md","content":"new"}]}']);

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

it('refuses a Tool call in one line naming house login while Kit home holds no Kit credential', async () => {
  const house = await startHouse();
  const home = await connected(house, false);
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_own' }));

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe('');
  expect(ran.stderr).toBe('house: this computer has no House connection; run house login\n');
  expect(house.requests).toEqual([]);
});

it("refuses a Tool call naming house login once house logout has ended the Kit's connection", async () => {
  const house = await startHouse();
  const home = await connected(house);
  house.route('POST', '/kit/kits/log-out', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOME: accountOf(home) }).exited).toBe(0);
  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(house.requests.map(({ path, headers, body }) => ({ path, authorization: headers.authorization, body }))).toEqual([
    { path: '/kit/kits/log-out', authorization: 'Bearer ahk_kit', body: {} },
  ]);
  expect(ran.status).toBe(1);
  expect(ran.stderr).toMatch(/^house: [^\n]*; run house login\n$/);
});

it('refuses a Tool call in one line naming house login once House no longer accepts the Kit credential', async () => {
  const house = await startHouse();
  const home = await connected(house);
  house.route('POST', '/', () => ({ status: 401, body: { error: 'invalid_token', error_description: 'A valid access token is required' } }));

  const ran = await runHouse(home, ['search', '{"query":"invoice"}']);

  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe('');
  expect(ran.stderr).toBe('house: House no longer accepts this computer; run house login\n');
  expect(house.requests.map(({ path, headers }) => [path, headers.authorization])).toEqual([['/', 'Bearer ahk_kit']]);
});

it("stops acting as the User when House had already disconnected the computer", async () => {
  const house = await startHouse();
  const home = await connected(house);
  house.route('POST', '/kit/kits/log-out', () => ({ status: 401, body: { error: { code: 'kit_credential_rejected' } } }));

  const logout = runKit(['logout'], { HOME: accountOf(home) });

  expect(await logout.exited).toBe(0);
  expect(logout.stdout()).toBe('Environment environment-one is disconnected; house login reconnects it.\n');
  expect((await runHouse(home, ['search', '{"query":"invoice"}'])).stderr).toMatch(/house login/);
});

it("never sends a call unlabelled when the conversation's bridge it names is gone", async () => {
  const house = await startHouse();
  const home = await connected(house);

  const ran = await runHouse(home, ['search', '{"query":"invoice"}'], join(home, 'bridges', 'gone.sock'));

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe('house: this House connection is closed; nothing to do from here\n');
  expect(house.requests).toEqual([]);
});

it("refuses house upload where the conversation's bridge it names is gone, never sending it as the Environment's own upload", async () => {
  const home = await temporaryHome();
  vi.stubEnv('HOME', accountOf(home));
  const owner = ownerSocket();
  vi.unstubAllEnvs();
  const opened: string[] = [];
  const listener = createServer((connection) => {
    opened.push(owner);
    connection.destroy();
  });
  listener.listen(owner);
  await once(listener, 'listening');
  onTestFinished(() => new Promise<void>((resolve) => listener.close(() => resolve())));

  const ran = await runHouse(home, ['upload'], join(home, 'bridges', 'gone.sock'));

  expect(ran).toEqual({ status: 1, stdout: '', stderr: 'house: this House connection is closed; nothing to do from here\n' });
  expect(opened).toEqual([]);
});

it('tells an Agent whose CLI sandbox refuses the bridge to run house directly', async () => {
  const house = await startHouse();
  const home = await connected(house);
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

function listing(house: House, tools: unknown[]): void {
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: { tools } } };
  });
}

function pasted(line: string): unknown {
  const command = line.slice('example: house '.length);
  return JSON.parse(execFileSync('sh', ['-c', `set -- ${command}; printf %s "$2"`], { encoding: 'utf8' }));
}

const HOUSE_HELP = [
  USAGE,
  'shell: Read Rooms',
  'info: Show details',
  'update: Change documents',
  'guide: Read the Guide',
  'agent_update: Change Agents and conversations',
  ...KIT_VERBS,
  UPLOAD,
  DOWNLOAD,
  AGENT_RUN,
];

it("prints house help as the usage line, one line per Tool House's help listing names, its name and title, and one per Kit verb, the same for house --help, asking under the Kit credential with no operation id", async () => {
  const house = await startHouse();
  const home = await connected(house);

  const help = await runHouse(home, ['help']);
  const dashed = await runHouse(home, ['--help']);

  expect(help).toEqual({ status: 0, stdout: `${HOUSE_HELP.join('\n')}\n`, stderr: '' });
  expect(dashed).toEqual(help);
  expect(house.requests.map((request) => request.headers.authorization)).toEqual(['Bearer ahk_kit', 'Bearer ahk_kit']);
  const asked = house.requests.map((request) => (request.body as McpCall).params);
  expect(asked.map((params) => params._meta[HELP_META])).toEqual([true, true]);
  expect(asked.map((params) => params._meta)).not.toContainEqual(expect.objectContaining({ 'agents.house/agent-operation': expect.anything() }));
  expect(help.stdout).not.toMatch(/\bcommit\b|\brebase\b|house push|house fetch|git (?:push|fetch|pull)/);
});

it("runs a Kit verb where House lists a Tool of its name", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    return { body: { jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list' ? { tools: [{ name: 'settings', inputSchema: {} }] } : shelled('a Tool answered') } };
  });
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace: '/srv/house' }));

  const ran = await runHouse(home, ['settings']);

  expect(ran).toEqual({ status: 0, stdout: 'skills\nworkspace /srv/house\n', stderr: '' });
  expect(house.requests).toEqual([]);
});

it.each([
  [
    'shell',
    [
      'shell: Read-only shell over `rooms/<handle>`.',
      '  command (required, 1 to 16000 characters): The command line.',
      '  cwd (at least 1 character): Starting directory; default `/`.',
      `  long: ${LONG}`,
      `example: house shell '{"command":"rg -n \\"deadline\\" rooms/team-notes"}'`,
    ],
  ],
  [
    'info',
    [
      'info: Details of whatever `path` names.',
      '  path (at least 1 character): Any link or reference.',
      '  history: `true` lists its revisions, newest first.',
      '  cursor (1 to 4096 characters): The `next_cursor` of the answer before.',
      `  long: ${LONG}`,
      `example: house info '{"path":"rooms/team-notes/plan.md"}'`,
    ],
  ],
  [
    'update',
    [
      'update: Change documents',
      '  changes (required, 1 to 10000 items): The changes, each with an `op`, applied all or none.',
      '  mount (at least 1 character): An empty folder; every change creates a document in it, all or none.',
      `  long: ${LONG}`,
      '  write path content [base]',
      '  move path to [base]',
      '  delete path [base]',
    ],
  ],
  [
    'agent_update',
    [
      'agent_update: Change Agents and conversations',
      '  create environment [cli] model [compaction_threshold]',
      '  request_send room [agent_function] payload [copy]',
      '  conversation_send conversation text',
    ],
  ],
  ['guide', ['guide: House’s guides and formats.', '  open [paths] [cursor]', '  search query [cursor]']],
])("prints house help %s from House's help listing, a Tool's arguments with their limits and its example, a family's ops one line each, update's own arguments first, the same for house <tool> --help", async (tool, expected) => {
  const house = await startHouse();
  const home = await connected(house);

  const help = await runHouse(home, ['help', tool]);
  const dashed = await runHouse(home, [tool, '--help']);

  expect(help).toEqual({ status: 0, stdout: `${expected.join('\n')}\n`, stderr: '' });
  expect(dashed).toEqual(help);
  expect(house.requests.map((request) => (request.body as McpCall).params._meta[HELP_META])).toEqual([true, true]);
});

it.each([
  [
    ['agent_update', 'conversation_send'],
    [
      'agent_update conversation_send',
      '  conversation (required): The conversation; for `mail`, one from `agent` `conversations`.',
      '  text (required, 1 to 100000 characters): `mail`: the mail; `conversation_send`: the message.',
      `example: house agent_update '{"op":"conversation_send","conversation":"0199c58f-219e-7cb0-bb53-f16947ccf25e","text":"Summarise what'\\''s changed today."}'`,
    ],
  ],
  [
    ['agent_update', 'create'],
    [
      'agent_update create',
      '  environment (required): Its Environment.',
      '  cli "claude-agent-acp" | "codex-acp" | "grok-build": Its CLI.',
      '  model (required, at least 1 character): Its model as the CLI names it.',
      '  compaction_threshold (more than 0, at most 2147483647): The context past which House compacts a conversation; null for never.',
      `example: house agent_update '{"op":"create","environment":"0199c5fd-aeeb-7757-a9fa-e923d5a4fd12","cli":"claude-agent-acp","model":"opus"}'`,
    ],
  ],
  [
    ['update', 'move'],
    [
      'update move',
      '  path (required, at least 1 character): The document or attachment.',
      '  to (required, at least 1 character): The new path; links to it follow.',
      '  base (1 to 64 characters): The `v_` revision you read; a folder’s `move` takes `{name: revision}`.',
      `example: house update '{"changes":[{"op":"move","path":"rooms/team-notes/plan.md","to":"rooms/team-notes/archive/plan.md"}]}'`,
    ],
  ],
  [
    ['guide', 'open'],
    [
      'guide open',
      '  paths (at least 1 item, each 1 to 200 characters): The pages `open` answers; none for `index`.',
      '  cursor (1 to 4096 characters): The `next_cursor` of the answer before.',
      `example: house guide '{"op":"open","paths":["reference/triggers"]}'`,
    ],
  ],
])("prints house help %j as that op's arguments with their wording and limits and its example in the CLI's form, which pastes as the op's example", async (named, expected) => {
  const house = await startHouse();
  const home = await connected(house);

  const help = await runHouse(home, ['help', ...named]);

  expect(help).toEqual({ status: 0, stdout: `${expected.join('\n')}\n`, stderr: '' });
  const [tool, op] = named as [string, string];
  const held = LISTING.find((one) => one.name === tool)!._meta[HELP_META];
  expect(pasted(expected.at(-1)!)).toEqual('ops' in held ? held.ops[op]!.example : undefined);
});

it.each([
  [['help', 'agent_update', 'conversation_ask'], 'agent_update has no op conversation_ask; house help agent_update lists what it takes'],
  [['help', 'update', 'set_field'], 'update has no op set_field; house help update lists what it takes'],
  [['help', 'shell', 'run'], 'shell has no op run; house help shell lists what it takes'],
  [['help', 'agent_update', 'constructor'], 'agent_update has no op constructor; house help agent_update lists what it takes'],
  [['help', 'search'], 'search is no Tool; house help lists the Tools'],
  [['help', 'search', 'pages'], 'search is no Tool; house help lists the Tools'],
  [['search', '--help'], 'search is no Tool; house help lists the Tools'],
])('refuses house %j naming the help that lists what there is', async (argv, refusal) => {
  const house = await startHouse();
  const home = await connected(house);

  const ran = await runHouse(home, argv);

  expect(ran).toEqual({ status: 1, stdout: '', stderr: `house: ${refusal}\n` });
});

it.each([
  [['shell', '-'], `${ARGUMENTS}, like house shell '{"command":"rg -n \\"deadline\\" rooms/team-notes"}'`],
  [['update', '-'], `${ARGUMENTS}, like house update '{"changes":[{"op":"write","path":"rooms/team-notes/plan.md","content":"# Plan\\n\\nShip the beta on Friday.\\n"}]}'`],
  [['agent_update', '-'], `${ARGUMENTS}, like house agent_update '{"op":"create","environment":"0199c5fd-aeeb-7757-a9fa-e923d5a4fd12","cli":"claude-agent-acp","model":"opus"}'`],
  [['upload', '-'], `${ARGUMENTS}, like house upload '{"path":"rooms/team-notes/photos"}'`],
  [['download', '-'], `${ARGUMENTS}, like house download '{"path":"rooms/<handle>/<path>","file":"<local file>"}'`],
  [['search', '-'], 'search is no Tool; house help lists the Tools'],
])('refuses house %j given arguments that are no JSON object with the named Tool\'s example, a family\'s first op\'s, and sends no call', async (argv, refusal) => {
  const house = await startHouse();
  const home = await connected(house);

  const ran = await runHouse(home, argv, undefined, [], {}, '["invoice"]');

  expect(ran).toEqual({ status: 1, stdout: '', stderr: `house: ${refusal}\n` });
  expect(house.requests.map((request) => (request.body as McpCall).method).filter((method) => method !== 'tools/list')).toEqual([]);
});

it.each([
  [
    'a nullable array of objects',
    {
      rows: {
        anyOf: [{ type: 'array', items: { type: 'object', properties: { a: { type: 'string', description: 'A.' } }, required: ['a'] } }, { type: 'null' }],
        description: 'Rows.',
      },
    },
    ['  rows: Rows.', '    a (required): A.'],
  ],
  [
    'an anyOf of two objects',
    {
      target: {
        anyOf: [
          { type: 'object', properties: { room: { type: 'string' } }, required: ['room'] },
          { type: 'object', properties: { path: { type: 'string' } } },
        ],
      },
    },
    ['  target', '    - room (required)', '    - path'],
  ],
  [
    'an array of arrays of objects',
    { grid: { type: 'array', items: { type: 'array', items: { type: 'object', properties: { cell: { type: 'string' } } } } } },
    ['  grid', '    cell'],
  ],
  [
    'an alternative that holds a oneOf',
    {
      v: {
        oneOf: [
          { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] },
          { type: 'string' },
        ],
      },
    },
    ['  v', '    - a', '    - b'],
  ],
  [
    'a $ref whose target holds the description, and one that points outside the schema',
    { v: { $ref: '#/$defs/a~1b~01c' }, far: { $ref: 'https://example.com/far', description: 'Far.' } },
    ['  v: From the target.', '  far: Far.'],
  ],
  [
    'an argument whose schema holds itself, once and no deeper',
    { root: { $ref: '#/$defs/node' } },
    ['  root', '    title: Its title.', '    children'],
  ],
  [
    'limits on a nested argument, an item and each alternative',
    {
      when: { type: 'object', properties: { every: { type: 'integer', minimum: 1, maximum: 60, description: 'Minutes.' } } },
      tags: { type: 'array', maxItems: 20, items: { type: 'string', enum: ['red', 'blue'] } },
      name: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
      level: { anyOf: [{ type: 'string', const: 'all' }, { type: 'number', exclusiveMaximum: 1 }] },
    },
    ['  when', '    every (1 to 60): Minutes.', '  tags (at most 20 items, each "red" | "blue")', '  name (at most 200 characters)', '  level "all" (less than 1)'],
  ],
])('prints the arguments of %s', async (_shape, properties, expected) => {
  const house = await startHouse();
  const home = await connected(house);
  const $defs = {
    'a/b~1c': { type: 'string', description: 'From the target.' },
    node: { type: 'object', properties: { title: { type: 'string', description: 'Its title.' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } } },
  };
  const inputSchema = { type: 'object', properties, $defs };
  listing(house, [{ name: 'shape', title: 'Shape', inputSchema, _meta: { [HELP_META]: { inputSchema, example: {} } } }]);

  const help = await runHouse(home, ['help', 'shape']);

  expect(help).toEqual({ status: 0, stdout: `${['shape: Shape', ...expected, "example: house shape '{}'"].join('\n')}\n`, stderr: '' });
});

it.each([
  [['update', '{"changes":[{"op":"write","path":"rooms/notebook/new.md","content":"new"}]}', '--help'], '--help'],
  [['rooms_list', '{}', '--bogus'], '--bogus'],
  [['--version'], '--version'],
  [['shell', '{"command":"ls"}', 'twice'], 'twice'],
  [['help', 'login', 'now'], 'now'],
  [['help', 'upload', 'write'], 'write'],
])('refuses house %j with its usage before it calls House', async (argv, unexpected) => {
  const house = await startHouse();
  const home = await connected(house);

  const ran = await runHouse(home, argv);

  expect(ran).toEqual({
    status: 1,
    stdout: '',
    stderr: `house: unexpected argument ${unexpected}; ${USAGE}\n`,
  });
  expect(house.requests).toEqual([]);
});

it.each([
  [['--help', 'upload'], `${UPLOAD_USAGE}\n${UPLOAD}`],
  [['--help', 'download', '--with-attachments'], `${DOWNLOAD_USAGE}\n${DOWNLOAD}`],
  [['help', 'download'], `${DOWNLOAD_USAGE}\n${DOWNLOAD}`],
  [['download', '--help'], `${DOWNLOAD_USAGE}\n${DOWNLOAD}`],
  [['help', 'upload'], `${UPLOAD_USAGE}\n${UPLOAD}`],
  [['upload', '--help'], `${UPLOAD_USAGE}\n${UPLOAD}`],
  [['help', 'agent', 'run'], `${AGENT_RUN_USAGE}\n${AGENT_RUN}`],
  [['agent', 'run', '--help'], `${AGENT_RUN_USAGE}\n${AGENT_RUN}`],
])('prints house %j as the usage of the command it names and calls nothing', async (argv, usage) => {
  const house = await startHouse();
  const home = await connected(house);

  const ran = await runHouse(home, argv);

  expect(ran).toEqual({ status: 0, stdout: `${usage}\n`, stderr: '' });
  expect(house.requests).toEqual([]);
});

it.each([
  [['upload', '--dry-run'], true, '--dry-run', UPLOAD_USAGE],
  [['upload', '--owner'], false, '--owner', UPLOAD_USAGE],
  [['upload', '--owner'], true, '--owner', UPLOAD_USAGE],
  [['upload', '{"file":"a.md","path":"rooms/notebook/a.md"}', '--owner'], false, '--owner', UPLOAD_USAGE],
  [['download', '--x'], false, '--x', DOWNLOAD_USAGE],
])('refuses house %j with its usage before it opens a Kit connection', async (argv, conversation, unexpected, usage) => {
  const home = await temporaryHome();
  vi.stubEnv('HOME', accountOf(home));
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
  const home = await connected(house);
  house.route('POST', '/', ({ body }) => {
    const message = body as { id: string } & McpCall;
    const failed = message.params.arguments?.command === 'ls rooms/private/house';
    return { body: { jsonrpc: '2.0', id: message.id, result: failed ? shelled('', 2, ['ls: path_not_found rooms/private/house']) : shelled('ROOM.md') } };
  });

  const failed = await runHouse(home, ['shell', '{"command":"ls rooms/private/house"}']);
  const listed = await runHouse(home, ['shell', '{"command":"ls rooms/private"}']);

  expect(failed).toEqual({ status: 2, stdout: 'exit: 2\nstderr: ls: path_not_found rooms/private/house\n', stderr: '' });
  expect(listed).toEqual({ status: 0, stdout: 'ROOM.md\n', stderr: '' });
});
