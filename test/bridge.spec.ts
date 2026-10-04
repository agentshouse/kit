import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until, type Received } from './double.ts';
import {
  appRemote,
  attachmentDouble,
  conversationCredential,
  directed,
  hostKit,
  lastInput,
  LISTING,
  opened,
  runs,
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

it("serves House's listed tools as the house verbs with House's help", async () => {
  const hosted = await hostKit();
  await opened(hosted);

  directed(hosted, '@house --help\n@house inspect --help\n@house search {"query":"notes"}');

  const [help, toolHelp, search] = await runs(hosted, 3);
  expect(help!.stdout).toBe(
    [
      "usage: house <tool> ['<arguments as JSON>']",
      'git push [commit]: Submit a Room commit to House; default HEAD. Use --owner only outside an Agent conversation. Native git push is not a House remote.',
      ...LISTING.map((tool) => `${tool.name}: ${tool.description}`),
    ].join('\n') + '\n',
  );
  expect(toolHelp!.stdout).toBe(`${LISTING[1]!.description}\n${JSON.stringify(LISTING[1]!.inputSchema, null, 2)}\n`);
  expect(search!.stdout).toBe('search answered\n');
  expect(hosted.mcp.map((received) => [received.headers['mcp-method'], called(received).params.name])).toEqual([
    ['tools/list', undefined],
    ['tools/list', undefined],
    ['tools/call', 'search'],
  ]);
});

it('attaches a fresh operation id to each mutation and none to a read', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const record = '{"room_ref":"r_room","source_ref":"s_source","body":"hello"}';

  directed(hosted, `@house append_record ${record}\n@house append_record ${record}\n@house search {"query":"hello"}`);

  await runs(hosted, 3);
  const operations = hosted.mcp.map((received) => called(received).params._meta[OPERATION]);
  expect(operations).toEqual([expect.stringMatching(UUID_V7), expect.stringMatching(UUID_V7), undefined]);
  expect(operations[0]).not.toBe(operations[1]);
});

it('asks House which tools write once per conversation, however many calls it forwards', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const record = '{"room_ref":"r_room","source_ref":"s_source","body":"hello"}';

  directed(hosted, `@house search {"query":"one"}\n@house append_record ${record}\n@house search {"query":"two"}`);

  await runs(hosted, 3);
  expect(hosted.house.requests.filter((received) => received.path === '/kit/tools/mutations')).toHaveLength(1);
  expect(hosted.mcp.map((received) => called(received).params._meta[OPERATION])).toEqual([
    undefined,
    expect.stringMatching(UUID_V7),
    undefined,
  ]);
});

it('uploads a local file through the attachments route and its transfer before upload_attachment answers', async () => {
  const hosted = await hostKit();
  const content = Buffer.from('quarterly numbers\n');
  await writeFile(join(hosted.workingDirectory, 'report.txt'), content);
  const transfers = await attachmentDouble(hosted);
  await opened(hosted);

  directed(hosted, '@house upload_attachment {"path":"report.txt","room_ref":"r_room"}');

  const [ran] = await runs(hosted, 1);
  expect(JSON.parse(ran!.stdout)).toEqual({ attachment: 'at_1' });
  const declared = hosted.house.requests.find((received) => received.path === '/kit/attachments/upload')!;
  expect(declared.headers.authorization).toBe(`Bearer ${conversationCredential('conversation-1')}`);
  expect(declared.body).toEqual({
    room_ref: 'r_room',
    version: expect.stringMatching(/^[0-9a-f-]{36}$/),
    name: 'report.txt',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  expect(transfers).toEqual([{ operation: 'operation-1', authorization: undefined, bytes: content }]);
  expect(hosted.mcp).toEqual([]);
});

it("uploads append_record's attachments and sends their references", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'a.txt'), 'first');
  await writeFile(join(hosted.workingDirectory, 'b.txt'), 'second');
  const transfers = await attachmentDouble(hosted);
  await opened(hosted);

  directed(
    hosted,
    '@house append_record {"room_ref":"r_room","source_ref":"s_source","body":"see","attachments":["a.txt","b.txt"]}',
  );

  expect((await runs(hosted, 1))[0]!.stdout).toBe('append_record answered\n');
  expect(transfers.map((transfer) => transfer.bytes.toString())).toEqual(['first', 'second']);
  expect(hosted.mcp.map(called).map((call) => call.params.arguments)).toEqual([
    { room_ref: 'r_room', source_ref: 's_source', body: 'see', attachments: ['at_1', 'at_2'] },
  ]);
  expect(called(hosted.mcp[0]!).params._meta[OPERATION]).toMatch(UUID_V7);
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
      status: 503,
      body: {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'house_overloaded: House is busy; call again in 5 s', data: { code: 'house_overloaded' } },
      },
    };
  });
  hosted.house.route('POST', '/kit/attachments/upload', () => ({
    status: 409,
    body: {
      error: {
        code: 'room_archived',
        message: 'room_archived: this Room is archived and read-only; its owner can unarchive it at /rooms/<room>/settings',
      },
    },
  }));

  directed(
    hosted,
    '@house search {"query":"one"}\n@house inspect {"path":"/private"}\n@house upload_attachment {"path":"report.txt"}',
  );

  expect((await runs(hosted, 3)).map((ran) => [ran.status, ran.stderr])).toEqual([
    [1, 'house: room_not_found: you have no Room with that room_ref; pass an r_… ref from list_rooms, not a handle\n'],
    [1, 'house: house_overloaded: House is busy; call again in 5 s\n'],
    [1, 'house: room_archived: this Room is archived and read-only; its owner can unarchive it at /rooms/<room>/settings\n'],
  ]);
});

it("prints the byte origin's refusal of an upload as House words it, with its delay", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'report.txt'), 'numbers\n');
  await attachmentDouble(hosted);
  hosted.house.route('POST', '/bytes/:grant', () => ({ status: 503, body: OVERLOADED }));
  await opened(hosted);

  directed(hosted, '@house upload_attachment {"path":"report.txt"}');

  expect((await runs(hosted, 1))[0]).toMatchObject({
    status: 1,
    stderr: 'house: house_overloaded: House is busy; call again in 5 s\n',
  });
});

it('says a refused upload transfer failed without its capability address', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'report.txt'), 'numbers\n');
  await attachmentDouble(hosted);
  hosted.house.route('POST', '/bytes/:grant', () => ({ status: 404 }));
  await opened(hosted);

  directed(hosted, '@house upload_attachment {"path":"report.txt"}');

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
      '@house upload_attachment {}',
      '@house upload_attachment {"path":"absent.txt"}',
      '@house upload_attachment {"path":"."}',
      '@house list_agents --help',
    ].join('\n'),
  );

  const form = `house: the arguments are one JSON object in single quotes, like house search '{"query":"invoice"}'\n`;
  expect((await runs(hosted, 6)).map((ran) => ran.stderr)).toEqual([
    form,
    form,
    'house: upload_attachment needs "path", a local file\n',
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
  const credentials = appRemote(hosted, commit);
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
