import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until, type Received } from './double.ts';
import { temporaryHome } from './kit.ts';
import {
  appRemote,
  conversationCredential,
  directed,
  helpLine,
  hostKit,
  lastInput,
  LISTING,
  opened,
  runs,
  uploadDouble,
  type McpCall,
} from './environment.ts';
import { OVERLOADED } from './rooms.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = 'agents.house/agent-operation';

const called = (received: Received) => received.body as McpCall;

it("reaches House with each process's own conversation credential and never shows it to the CLI", async () => {
  const hosted = await hostKit([{}, { kind: 'claude-agent-acp' }]);
  await opened(hosted);
  await opened(hosted, 'conversation-2', 'agent-2');

  directed(hosted, '@house search {"query":"one"}');
  directed(hosted, '@house search {"query":"two"}', 'conversation-2', 'agent-2');

  expect((await runs(hosted, 2)).map((ran) => ran.status)).toEqual([0, 0]);
  const bearers = Object.fromEntries(
    hosted.mcp.map((received) => [called(received).params.arguments!.query, received.headers.authorization]),
  );
  expect(bearers).toEqual({
    one: `Bearer ${conversationCredential('conversation-1')}`,
    two: `Bearer ${conversationCredential('conversation-2')}`,
  });
  const asked = hosted.house.requests.filter((received) => received.path.endsWith('/credential'));
  expect(asked.map((received) => [received.params.conversation, received.headers.authorization])).toEqual([
    ['conversation-1', 'Bearer ahk_held'],
    ['conversation-2', 'Bearer ahk_held'],
  ]);
  const seen = JSON.stringify([await hosted.adapterLog(), hosted.socket.frames]);
  expect(seen).not.toContain(conversationCredential('conversation-1'));
  expect(seen).not.toContain(conversationCredential('conversation-2'));
});

it.each([60, 120])("opens a conversation and answers its house calls under a Kit home %i characters deeper than a temporary directory", async (deeper) => {
  const home = join(await temporaryHome(), 'k'.repeat(deeper));
  await mkdir(home);
  const hosted = await hostKit([{}], { home, skills: false });

  hosted.input({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  directed(hosted, '@house search {"query":"one"}');
  expect((await runs(hosted, 1)).map((ran) => ran.status)).toEqual([0]);
});

it("keeps a conversation's house on its bridge credential while Kit home holds the User's own agent's connection", async () => {
  const hosted = await hostKit([{}], { prepare: (home) => writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: 'http://127.0.0.1:9', user: 'user-one', credential: 'ahp_own' })) });
  await opened(hosted);

  directed(hosted, '@house search {"query":"one"}');

  expect((await runs(hosted, 1)).map((ran) => ran.status)).toEqual([0]);
  expect(hosted.mcp.map((received) => received.headers.authorization)).toEqual([
    `Bearer ${conversationCredential('conversation-1')}`,
  ]);
});

it("serves House's listed tools as the house verbs with House's help", async () => {
  const hosted = await hostKit();
  await opened(hosted);

  directed(hosted, '@house --help\n@house inspect --help\n@house search {"query":"notes"}');

  const [help, toolHelp, search] = await runs(hosted, 3);
  expect(help!.stdout).toBe(
    [
      "usage: house <tool> ['<arguments as JSON>']",
      'help',
      "push [commit]: sends the Local copy's committed changes to House",
      "fetch: records House's changes on each Local copy's refs/house/received",
      'download: writes a binary file of a Room to the local file named by file',
      ...LISTING.map(helpLine),
    ].join('\n') + '\n',
  );
  const inspect = LISTING.find((tool) => tool.name === 'inspect')!;
  expect(toolHelp!.stdout).toBe(`${inspect.description}\n${JSON.stringify(inspect.inputSchema)}\n`);
  expect(search!.stdout).toBe('search answered\n');
  expect(hosted.mcp.map((received) => [received.headers['mcp-method'], called(received).params.name])).toEqual([
    ['tools/list', undefined],
    ['tools/list', undefined],
    ['tools/call', 'search'],
  ]);
});

it('attaches a fresh operation id to every Tool call, a read included, and never asks House which Tools write', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const record = '{"room_ref":"r_room","source_ref":"s_source","body":"hello"}';

  const command = '{"command":"create_room","arguments":{"name":"Notes"}}';

  directed(
    hosted,
    `@house append_record ${record}\n@house append_record ${record}\n@house run_command ${command}\n@house search {"query":"hello"}`,
  );

  await runs(hosted, 4);
  const operations = hosted.mcp.map((received) => called(received).params._meta[OPERATION]);
  expect(operations).toEqual(Array(4).fill(expect.stringMatching(UUID_V7)));
  expect(new Set(operations).size).toBe(4);
  expect(hosted.house.requests.filter((received) => received.path.startsWith('/kit/tools/'))).toEqual([]);
});

it('resends a write House answers pending, and one whose answer is lost, as the same request until its outcome arrives', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  let calls = 0;
  hosted.tools.append_record = (_args, request) => {
    calls++;
    if (calls === 1) {
      const operation = called(request).params._meta[OPERATION];
      return { content: [{ type: 'text', text: JSON.stringify({ pending: { retry_after: 1, operation_id: operation } }) }] };
    }
    return calls === 2 ? null : { content: [{ type: 'text', text: 'record: ep_1' }] };
  };

  directed(hosted, '@house append_record {"room_ref":"r_room","source_ref":"s_source","body":"hello"}');

  expect((await runs(hosted, 1))[0]).toMatchObject({ status: 0, stdout: 'record: ep_1\n', stderr: '' });
  expect(hosted.mcp).toHaveLength(3);
  expect(hosted.mcp.map((received) => received.body)).toEqual(Array(3).fill(hosted.mcp[0]!.body));
  expect(called(hosted.mcp[0]!).params._meta[OPERATION]).toMatch(UUID_V7);
});

it("uploads the local file named by file to its path in the Room, filling its size, digest and media type as House's argument schema takes them", async () => {
  const hosted = await hostKit();
  const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  await mkdir(join(hosted.workingDirectory, 'messenger-evidence'));
  await writeFile(join(hosted.workingDirectory, 'messenger-evidence', 'messenger-light.jpg'), content);
  const transfers = uploadDouble(hosted);
  await opened(hosted);

  directed(
    hosted,
    '@house upload {"file":"messenger-evidence/messenger-light.jpg","room_ref":"porting","path":"evidence/messenger-next-light.jpg"}',
  );

  expect((await runs(hosted, 1))[0]).toMatchObject({
    status: 0,
    stdout: 'path: evidence/messenger-next-light.jpg\nrevision: fr_1\n',
    stderr: '',
  });
  const [declared] = hosted.mcp;
  expect(hosted.mcp).toHaveLength(1);
  expect(declared!.headers.authorization).toBe(`Bearer ${conversationCredential('conversation-1')}`);
  expect(called(declared!).params.name).toBe('upload');
  expect(called(declared!).params.arguments).toEqual({
    room_ref: 'porting',
    path: 'evidence/messenger-next-light.jpg',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    media_type: 'image/jpeg',
  });
  expect(transfers).toEqual([{ operation: 'operation-1', authorization: undefined, bytes: content }]);
});

it("prints House's own line for a refused call, and no route, status or body", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'report.txt'), 'numbers\n');
  hosted.tools.search = () => ({
    isError: true,
    content: [{ type: 'text', text: 'room_not_found: you have no Room with that room_ref; pass an r_… ref from list_rooms, not a handle\n' }],
  });
  await opened(hosted);
  hosted.house.route('POST', '/', (request) => {
    const message = request.body as McpCall & { id: string };
    if (message.params.name !== 'inspect') {
      return { body: { jsonrpc: '2.0', id: message.id, result: hosted.tools.search!(message.params.arguments ?? {}, request) } };
    }
    return {
      status: 500,
      body: {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: 'internal_error: House failed on this call; call again once',
          data: { code: 'internal_error', retryable: false },
        },
      },
    };
  });

  directed(hosted, '@house search {"query":"one"}\n@house inspect {"path":"/rooms/private"}');

  expect((await runs(hosted, 2)).map((ran) => [ran.status, ran.stderr])).toEqual([
    [1, 'house: room_not_found: you have no Room with that room_ref; pass an r_… ref from list_rooms, not a handle\n'],
    [1, 'house: internal_error: House failed on this call; call again once\n'],
  ]);
});

it("prints the byte origin's refusal of an upload as House words it, with its delay", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'report.txt'), 'numbers\n');
  uploadDouble(hosted);
  hosted.house.route('POST', '/bytes/:grant', () => ({ status: 503, body: OVERLOADED }));
  await opened(hosted);

  directed(hosted, '@house upload {"file":"report.txt","room_ref":"r_room","path":"report.txt"}');

  expect((await runs(hosted, 1))[0]).toMatchObject({
    status: 1,
    stderr: 'house: house_overloaded: House is busy; call again in 5 s\n',
  });
});

it('says a refused upload transfer failed without its capability address', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'report.txt'), 'numbers\n');
  uploadDouble(hosted);
  hosted.house.route('POST', '/bytes/:grant', () => ({ status: 404 }));
  await opened(hosted);

  directed(hosted, '@house upload {"file":"report.txt","room_ref":"r_room","path":"report.txt"}');

  expect((await runs(hosted, 1))[0]).toMatchObject({
    status: 1,
    stderr: 'house: the upload answered 404; upload the file again\n',
  });
});

it('refuses arguments that are no JSON object and a file it cannot read in one line each', async () => {
  const hosted = await hostKit();
  await opened(hosted);

  directed(
    hosted,
    [
      '@house search invoice',
      '@house search ["invoice"]',
      '@house upload {}',
      '@house upload {"path":"report.txt","room_ref":"r_room"}',
      '@house upload {"file":"absent.txt","room_ref":"r_room","path":"absent.txt"}',
      '@house upload {"file":".","room_ref":"r_room","path":"folder"}',
      '@house list_agents --help',
    ].join('\n'),
  );

  const form = `house: the arguments are one JSON object in single quotes, like house search '{"query":"invoice"}'\n`;
  expect((await runs(hosted, 7)).map((ran) => ran.stderr)).toEqual([
    form,
    form,
    'house: upload needs "file", a local file\n',
    'house: upload needs "file", a local file\n',
    'house: absent.txt is not a readable file\n',
    'house: . is a folder; upload one file at a time\n',
    `house: list_agents is no Tool; house find_command '{"query":"list_agents"}' finds Commands\n`,
  ]);
  expect(hosted.mcp.filter((received) => called(received).method === 'tools/call')).toEqual([]);
});

it('gives every call it sends its own request id', async () => {
  const hosted = await hostKit();
  await opened(hosted);

  directed(hosted, '@house search {"query":"one"}\n@house search {"query":"two"}\n@house --help');

  await runs(hosted, 3);
  const ids = hosted.mcp.map((received) => (received.body as { id: unknown }).id);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(ids.length);
});

it('carries the credential on a Git call to a House App source remote', async () => {
  const hosted = await hostKit();
  const commit = 'a'.repeat(40);
  const credentials = appRemote(hosted.house, commit);
  await opened(hosted);

  directed(hosted, `@git ls-remote ${hosted.house.origin}/app/a_app.git`);

  const [ran] = await runs(hosted, 1);
  expect(ran).toMatchObject({ status: 0, stdout: `${commit}\tHEAD\n${commit}\trefs/heads/main\n` });
  expect(credentials).toEqual([conversationCredential('conversation-1')]);
});

it("closes the process's socket and Git proxy when the process exits", async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const started = (await hosted.adapterLog()).find(
    (entry) => entry.method === 'initialize' && (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined,
  )!;
  const env = started.env as Record<string, string>;
  const proxy = /^url\.(.+)\/app\/\.insteadOf$/.exec(env.GIT_CONFIG_KEY_0!)![1]!;
  expect(env.GIT_CONFIG_VALUE_0).toBe(`${hosted.house.origin}/app/`);
  expect(await answers(env.HOUSE_BRIDGE!)).toBe(true);

  hosted.input({ kind: 'kill' });
  await hosted.ack(lastInput());

  await until(() => !existsSync(env.HOUSE_BRIDGE!));
  expect(await answers(env.HOUSE_BRIDGE!)).toBe(false);
  await expect(fetch(`${proxy}/app/a_app.git/info/refs`)).rejects.toThrow();
});

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sent = request({ socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, (answer) => {
      answer.resume();
      resolve(true);
    });
    sent.on('error', () => resolve(false));
    sent.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}
