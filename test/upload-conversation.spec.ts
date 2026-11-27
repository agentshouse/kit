import { CONVERSATION_META_KEY } from '@agentshouse/kit-wire';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentInstructions } from '@agentshouse/skills';
import { expect, it, onTestFinished } from 'vitest';
import { until, type Received } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { house, OVERLOADED, serveRooms, type Room, type Rooms } from './rooms.ts';

interface Shelled {
  sh: string;
  status: number;
  stdout: string;
  stderr: string;
}

async function shell(hosted: Hosted, command: string, conversation = 'conversation-1', agent = 'agent-1'): Promise<Shelled> {
  const before = (await hosted.adapterLog()).filter((entry) => 'sh' in entry).length;
  hosted.call({ kind: 'message', conversation_id: conversation, agent_id: agent, text: `@sh ${command}`, first: false });
  return until(async () => (await hosted.adapterLog()).filter((entry) => 'sh' in entry)[before] as unknown as Shelled | undefined);
}

function changesOf(received: Received): unknown {
  return (received.body as { params: { arguments: { changes: unknown } } }).params.arguments.changes;
}

function editOperations(hosted: Hosted): string[] {
  return hosted.mcp
    .filter((received) => (received.body as { params: { name?: string } }).params.name === 'update')
    .map((received) => (received.body as { params: { _meta: Record<string, string> } }).params._meta['agents.house/agent-operation']!);
}

interface Copied {
  hosted: Hosted;
  rooms: Rooms;
  room: Room;
  copy: string;
  deny: (conversation: string) => void;
}

async function opened(hosted: Hosted, room: Room, index: number): Promise<string> {
  hosted.call({ kind: 'open', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, room_ref: room.ref, name: `Plan ${index}` });
  await hosted.result(lastCall());
  return join(hosted.workspace, 'conversations', room.handle, `Plan ${index}`);
}

async function copied(routes = [{}], opening = true): Promise<Copied> {
  const hosted = await hostKit(routes);
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'Alpha\n');
  room.put('index.md', 'See [alpha](a.md).\n');
  room.put('plan.md', 'one\n');
  rooms.answered = [room];
  await rooms.download([room]);
  let copy = '';
  for (let index = routes.length; opening && index >= 1; index--) copy = await opened(hosted, room, index);
  return { hosted, rooms, room, copy, deny: (conversation) => rooms.denied.add(conversation) };
}

const BIG = 680_000;

function bigFile(name: string, bytes: number): string {
  return `head -c ${bytes} /dev/zero | tr '\\000' '\\001' > ${name}`;
}

it("uploads a Room's folder from a Conversation process and a conversation's copy under the Kit credential naming the conversation that runs it, never as the Environment's own upload, and takes no --owner there", async () => {
  const { hosted, rooms, room, deny } = await copied([{}, { kind: 'claude-agent-acp' }]);
  deny('conversation-2');

  const first = await shell(hosted, `cd ${room.repository} && echo two >> plan.md && house upload`);
  const second = await shell(hosted, 'cd ./. && echo three >> plan.md && house upload', 'conversation-2', 'agent-2');
  const owner = await shell(hosted, 'house upload --owner', 'conversation-2', 'agent-2');

  expect(first).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(second.status).toBe(1);
  expect(second.stderr).toContain('operation_denied');
  expect(owner).toMatchObject({ status: 1, stderr: expect.stringMatching(/^house: unexpected argument --owner; usage: house upload, /) });
  expect(
    rooms.edits().map((received) => [received.headers.authorization, (received.body as { params: { _meta: Record<string, string> } }).params._meta[CONVERSATION_META_KEY]]),
  ).toEqual([
    ['Bearer ahk_held', 'conversation-1'],
    ['Bearer ahk_held', 'conversation-2'],
  ]);
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/update')).toEqual([]);
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\n');
});

it('uploads a move from a conversation and writes the links House rewrote, which it answers without their text, into the working files', async () => {
  const { hosted, rooms, room, copy } = await copied();
  const alpha = room.revision('a.md');

  const moved = await shell(hosted, 'mv a.md b.md && house upload');

  expect(moved).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(rooms.edits().map(changesOf)).toEqual([[{ op: 'move', path: '/rooms/notes/a.md', to: '/rooms/notes/b.md', base: alpha }]]);
  expect(await readFile(join(copy, 'index.md'), 'utf8')).toBe('See [alpha](b.md).\n');
  expect(JSON.parse(await readFile(join(copy, '.house'), 'utf8')).files['index.md'].revision).toBe(room.revision('index.md'));
});

it("downloads House's changes into the copy from a Conversation process", async () => {
  const { hosted, room } = await copied([{}], false);
  room.put('plan.md', 'one, from House\n');

  const downloaded = await shell(hosted, 'house download');

  expect(downloaded).toMatchObject({ status: 0, stdout: '/rooms/notes: 1 file updated from House\n' });
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe('one, from House\n');
});

it("prompts a conversation's first message while a house download still waits for House's selection of Local copies", async () => {
  const { hosted, room } = await copied([{}], false);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  hosted.house.route('POST', '/kit/local-copies/selection/read', async () => {
    await released;
    return { body: { local_copy: { rooms: [{ room_ref: room.ref, room_handle: room.handle }] } } };
  });
  const selections = () => hosted.house.requests.filter((request) => request.path === '/kit/local-copies/selection/read').length;
  const asked = selections();
  const downloading = house(hosted, '/', 'download');
  await until(() => selections() > asked);

  hosted.call({ kind: 'message', text: 'hello', first: true });

  const prompt = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  const opening = `${agentInstructions().join('\n')}\n\n`;
  expect((prompt.params as { prompt: { text: string }[] }).prompt[0]!.text.slice(0, opening.length)).toBe(opening);
  release();
  expect(await downloading).toMatchObject({ status: 0 });
});

it(
  'sends a batch above the MCP bound as one prepared upload under its operation, and resends it when its answer is lost',
  async () => {
    const { hosted, rooms, room } = await copied();
    const big = '\u0001'.repeat(BIG);
    rooms.dropsEdits = 1;

    const uploaded = await shell(hosted, `${bigFile('big.md', BIG)} && house upload`);

    expect(uploaded).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
    const bytes = Buffer.from(JSON.stringify({ changes: [{ op: 'write', path: '/rooms/notes/big.md', content: big }] }));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(rooms.prepared).toEqual([{ paths: ['/rooms/notes/big.md'], bytes: bytes.length, sha256, long: true }]);
    expect(rooms.uploaded).toEqual([bytes]);
    const sent = rooms.edits().map((received) => (received.body as { params: { arguments: unknown } }).params.arguments);
    expect(sent).toEqual([{ paths: ['/rooms/notes/big.md'], upload: { url: expect.any(String), operation: expect.any(String), bytes: bytes.length, sha256 }, long: true }, sent[0]]);
    const operations = hosted.mcp
      .filter((received) => (received.body as { params: { name?: string } }).params.name === 'update')
      .map((received) => (received.body as { params: { _meta: Record<string, string> } }).params._meta['agents.house/agent-operation']);
    expect(operations).toHaveLength(3);
    expect(new Set(operations).size).toBe(1);
    expect(room.batches).toHaveLength(1);
    expect(room.files.get('big.md')!.content).toBe(big);
  },
  // Preparing, uploading and retrying 800 KB can exceed the default on the two-vCPU runner.
  60_000,
);

it('uploads a prepared batch again when the byte origin refuses it with a refusal it marks retryable, and lands it', async () => {
  const { hosted, rooms } = await copied();
  rooms.refusesUploads = [{ status: 503, body: OVERLOADED }];

  const landed = await shell(hosted, `${bigFile('big.md', 800_000)} && house upload`);

  expect(landed).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(hosted.house.requests.filter((request) => request.path.startsWith('/uploads/'))).toHaveLength(2);
  expect(rooms.uploaded).toHaveLength(1);
});

it("prints the byte origin's refusal of a prepared batch it does not mark retryable as House words it, and the next upload lands it", async () => {
  const { hosted, rooms } = await copied();
  rooms.refusesUploads = [
    {
      status: 409,
      body: { error: { code: 'invalid_upload', message: 'invalid_upload: the uploaded edit does not match its upload; run the same command again', retryable: false } },
    },
  ];

  const refused = await shell(hosted, `${bigFile('big.md', 800_000)} && house upload`);
  const landed = await shell(hosted, 'house upload');

  expect(refused).toMatchObject({ status: 1, stderr: 'house: invalid_upload: the uploaded edit does not match its upload; run the same command again\n' });
  expect(landed).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
});

function refusingFirstEdit(hosted: Hosted, status: number, error: { message: string; data: { code: string; retryable: boolean } }): void {
  let refused = false;
  hosted.house.route('POST', '/', (request) => {
    hosted.mcp.push(request);
    const message = request.body as { id: string; params: { name: string; arguments: Record<string, unknown> } };
    if (!refused && message.params.name === 'update') {
      refused = true;
      return { status, body: { jsonrpc: '2.0', id: message.id, error: { code: -32000, ...error } } };
    }
    return { body: { jsonrpc: '2.0', id: message.id, result: hosted.tools[message.params.name]!(message.params.arguments, request) } };
  });
}

it('sends an upload House refuses with a refusal it marks retryable again under its operation until House lands it', async () => {
  const { hosted, room } = await copied();
  refusingFirstEdit(hosted, 503, { message: 'house_overloaded: House is busy; call again in 5 s', data: { code: 'house_overloaded', retryable: true } });

  const landed = await shell(hosted, 'echo two >> plan.md && house upload');

  expect(landed).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\n');
  const operations = editOperations(hosted);
  expect(operations).toHaveLength(2);
  expect(new Set(operations).size).toBe(1);
});

it("answers the CLI House's own words for an upload refusal it does not mark retryable, whatever its status, and the next upload lands it", async () => {
  const { hosted, room } = await copied();
  refusingFirstEdit(hosted, 500, { message: 'internal_error: House failed on this call; call again once', data: { code: 'internal_error', retryable: false } });

  const refused = await shell(hosted, 'echo two >> plan.md && house upload');

  expect(refused).toMatchObject({ status: 1, stderr: 'house: internal_error: House failed on this call; call again once\n' });
  expect(editOperations(hosted)).toHaveLength(1);
  const landed = await shell(hosted, 'house upload');
  expect(landed).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\n');
});

it("writes the Room's current instructions back into a conversation's upload House keeps as a proposal, and prints the proposal that waits in its person's Asks you", async () => {
  const { hosted, rooms, room, copy } = await copied();
  room.put('settings/instructions.md', 'Keep notes short.\n');
  room.proposing = { base_version: 1, waits_on: 'Ada' };
  await house(hosted, copy, 'download');
  const current = room.revision('settings/instructions.md');

  const proposed = await shell(hosted, "echo 'Date every note.' >> settings/instructions.md && house upload && house upload");

  expect(proposed).toMatchObject({
    status: 0,
    stdout:
      "House accepted 0 files of /rooms/notes.\n/rooms/notes/settings/instructions.md: House keeps your change as a proposal, which waits for Ada to answer it in their Asks you; this copy holds the Room's current instructions again\nNothing to upload: /rooms/notes matches House.\n",
  });
  expect(rooms.edits().map(changesOf)).toEqual([
    [{ op: 'write', path: '/rooms/notes/settings/instructions.md', content: 'Keep notes short.\nDate every note.\n', base: current }],
  ]);
  expect(room.proposals).toEqual([{ proposal: 'p-1', content: 'Keep notes short.\nDate every note.\n', base: current }]);
  expect(await readFile(join(copy, 'settings', 'instructions.md'), 'utf8')).toBe('Keep notes short.\n');
  expect(JSON.parse(await readFile(join(copy, '.house'), 'utf8')).files['settings/instructions.md'].revision).toBe(current);
});
