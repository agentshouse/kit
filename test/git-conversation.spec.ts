import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until, type Received } from './double.ts';
import { conversationCredential, hostKit, type Hosted } from './environment.ts';
import { commitAll, git, serveRooms, type Room, type Rooms } from './rooms.ts';

interface Shelled {
  sh: string;
  status: number;
  stdout: string;
  stderr: string;
}

async function shell(hosted: Hosted, command: string, conversation = 'conversation-1', agent = 'agent-1'): Promise<Shelled> {
  const before = (await hosted.adapterLog()).filter((entry) => 'sh' in entry).length;
  hosted.input({ kind: 'message', conversation_id: conversation, agent_id: agent, text: `@sh ${command}`, files: [], first: false });
  return until(async () => (await hosted.adapterLog()).filter((entry) => 'sh' in entry)[before] as unknown as Shelled | undefined);
}

function changesOf(received: Received): unknown {
  return (received.body as { params: { arguments: { changes: unknown } } }).params.arguments.changes;
}

async function copied(
  routes = [{}],
): Promise<{ hosted: Hosted; rooms: Rooms; room: Room; edits: () => Received[]; deny: (conversation: string) => void }> {
  const hosted = await hostKit(routes);
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/a.md', 'Alpha\n');
  room.put('library/index.md', 'See [alpha](a.md).\n');
  room.put('library/plan.md', 'one\n');
  await rooms.select([room]);
  return {
    hosted,
    rooms,
    room,
    edits: rooms.edits,
    deny: (conversation) => rooms.denied.add(`Bearer ${conversationCredential(conversation)}`),
  };
}

it("pushes from a Conversation process under that conversation's own credential and never the Environment's", async () => {
  const { hosted, room, edits, deny } = await copied([{}, { kind: 'claude-agent-acp' }]);
  deny('conversation-2');

  const first = await shell(
    hosted,
    `cd ${room.repository} && echo two >> library/plan.md && git commit -qam two && house git push`,
  );
  const second = await shell(
    hosted,
    `cd ${room.repository} && echo three >> library/plan.md && git commit -qam three && house git push`,
    'conversation-2',
    'agent-2',
  );
  const owner = await shell(hosted, `cd ${room.repository} && house git push --owner`, 'conversation-2', 'agent-2');

  expect(first).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}\.\n$/) });
  expect(second.status).toBe(1);
  expect(second.stderr).toContain('operation_denied');
  expect(owner).toMatchObject({ status: 1, stderr: 'house: --owner is not for Agent conversations; run house git push without it\n' });
  expect(edits().map((received) => received.headers.authorization)).toEqual([
    `Bearer ${conversationCredential('conversation-1')}`,
    `Bearer ${conversationCredential('conversation-2')}`,
  ]);
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/batch')).toEqual([]);
  expect(room.files.get('library/plan.md')!.content).toBe('one\ntwo\n');
});

it('sends a committed git mv the shim saw as a House rename that keeps identity and brings the rewritten references home', async () => {
  const { hosted, room, edits } = await copied();
  const alpha = room.revision('library/a.md');

  const moved = await shell(hosted, `cd ${room.repository} && git mv library/a.md library/b.md && git commit -qm move && house git push`);

  expect(moved).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}; main is at [0-9a-f]{12}\.\n$/) });
  expect(edits().map(changesOf)).toEqual([
    [{ op: 'rename', path: '/rooms/notes/library/a.md', to: '/rooms/notes/library/b.md', base: alpha }],
  ]);
  expect(room.files.get('library/b.md')!.revision).toBe(alpha);
  expect(room.files.get('library/index.md')!.content).toBe('See [alpha](b.md).\n');
  expect(await readFile(join(room.repository, 'library/index.md'), 'utf8')).toBe('See [alpha](b.md).\n');
  expect(git(room.repository, 'status', '--porcelain')).toBe('');
});

it('sends no rename for a failed, undone or uncommitted move', async () => {
  const { hosted, room, edits } = await copied();
  const plan = room.revision('library/plan.md');

  const attempts = await shell(
    hosted,
    [
      `cd ${room.repository}`,
      '{ git mv library/missing.md library/x.md 2>/dev/null; true; }',
      'git mv library/a.md library/b.md',
      'git mv library/b.md library/a.md',
      'git mv library/plan.md library/p2.md',
      'house git push',
    ].join(' && '),
  );
  const undone = await shell(
    hosted,
    [
      `cd ${room.repository}`,
      'git reset -q --hard',
      'mv library/plan.md library/p2.md',
      'git add -A',
      'git commit -qm "delete and add"',
      'house git push',
    ].join(' && '),
  );

  expect(attempts).toMatchObject({ status: 0, stdout: expect.stringMatching(/^Nothing to submit/) });
  expect(undone.status).toBe(0);
  expect(edits().map(changesOf)).toEqual([
    [
      { op: 'create', path: '/rooms/notes/library/p2.md', content: 'one\n' },
      { op: 'remove', path: '/rooms/notes/library/plan.md', base: plan },
    ],
  ]);
  expect(room.files.get('library/p2.md')!.revision).not.toBe(plan);
});

it("names each working copy in a conversation's first prompt", async () => {
  const { hosted, room } = await copied();

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  const prompt = await until(async () =>
    (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'),
  );
  const block = (prompt.params as { prompt: { text: string }[] }).prompt[0]!.text.split('\n\n')[0]!.split('\n');
  expect(block.slice(3)).toEqual([
    'These House paths are Git working copies here; commit in one and run `house git push` to send the commit to House:',
    `/rooms/notes: ${room.repository}`,
  ]);
});

it('sends a change set above the MCP bound as one prepared upload under the push operation, and resends that upload after a lost answer', async () => {
  const { hosted, rooms, room, edits } = await copied();
  const big = '\u0001'.repeat(800_000);
  await writeFile(join(room.repository, 'library/big.md'), big);
  commitAll(room.repository, 'big');
  rooms.dropsEdits = 1;

  const lost = await shell(hosted, `cd ${room.repository} && house git push`);
  const recovered = await shell(hosted, `cd ${room.repository} && house git push`);

  expect(lost.status).toBe(1);
  expect(lost.stderr).toContain('did not arrive');
  expect(recovered).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}\.\n$/) });
  const bytes = Buffer.from(JSON.stringify({ changes: [{ op: 'create', path: '/rooms/notes/library/big.md', content: big }] }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(rooms.prepared).toEqual([{ paths: ['/rooms/notes/library/big.md'], bytes: bytes.length, sha256 }]);
  expect(rooms.uploaded).toEqual([bytes]);
  const uploaded = edits().map((received) => (received.body as { params: { arguments: unknown } }).params.arguments);
  expect(uploaded).toEqual([
    { paths: ['/rooms/notes/library/big.md'], upload: { url: expect.any(String), operation: expect.any(String), bytes: bytes.length, sha256 } },
    uploaded[0],
  ]);
  const operations = hosted.mcp
    .filter((received) => ['run_command', 'edit'].includes(String((received.body as { params: { name?: string } }).params.name)))
    .map((received) => (received.body as { params: { _meta: Record<string, string> } }).params._meta['agents.house/agent-operation']);
  expect(operations).toHaveLength(3);
  expect(new Set(operations).size).toBe(1);
  expect(room.batches).toHaveLength(1);
  expect(room.files.get('library/big.md')!.content).toBe(big);
});

it("prints House's refusal of a push as House words it, keeps its delay, and the next push lands it", async () => {
  const { hosted, room } = await copied();
  let overloaded = false;
  hosted.house.route('POST', '/', (request) => {
    hosted.mcp.push(request);
    const message = request.body as { id: string; params: { name: string; arguments: Record<string, unknown> } };
    if (!overloaded) {
      overloaded = true;
      return {
        status: 503,
        body: {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'house_overloaded: House is busy; call again in 5 s', data: { code: 'house_overloaded' } },
        },
      };
    }
    return { body: { jsonrpc: '2.0', id: message.id, result: hosted.tools.edit!(message.params.arguments, request) } };
  });

  const refused = await shell(hosted, `cd ${room.repository} && echo two >> library/plan.md && git commit -qam two && house git push`);
  const landed = await shell(hosted, `cd ${room.repository} && house git push`);

  expect(refused).toMatchObject({ status: 1, stderr: 'house: house_overloaded: House is busy; call again in 5 s\n' });
  expect(landed).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}\.\n$/) });
  expect(room.files.get('library/plan.md')!.content).toBe('one\ntwo\n');
});

it('drops an expired rename House never applied when another writer took both of its paths', async () => {
  const { hosted, room } = await copied();
  let calls = 0;
  hosted.tools.edit = () =>
    ++calls === 1 ? null : { isError: true, content: [{ type: 'text', text: 'operation_expired: this operation is over 7 days old and its outcome is gone; read the current files and send again\n' }] };

  const lost = await shell(hosted, `cd ${room.repository} && git mv library/a.md library/b.md && git commit -qm move && house git push`);
  room.remove('library/a.md');
  room.put('library/b.md', 'Another writer\n');
  const expired = await shell(hosted, `cd ${room.repository} && house git push`);

  expect(lost.stderr).toContain('did not arrive');
  expect(expired.status).toBe(1);
  expect(expired.stderr).toContain('House does not hold');
  expect(git(room.repository, 'show', 'refs/house/received:library/b.md')).toBe('Another writer\n');
  expect(await readFile(join(room.repository, 'library/b.md'), 'utf8')).toBe('Alpha\n');
});

it('names the copies of a selection still being read in a first prompt that arrives meanwhile', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/a.md', 'Alpha\n');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  hosted.house.route('POST', '/kit/door/bootstrap', async () => {
    await held;
    return { body: { scopes: [room.bundle()] } };
  });
  rooms.selection = { rooms: [{ room_ref: room.ref, room_handle: room.handle }], private: false };
  hosted.socket.send({ type: 'work_available', subject: 'working_copy' });
  await until(() => hosted.house.requests.some((request) => request.path === '/kit/door/bootstrap'));

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();

  const prompt = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  const block = (prompt.params as { prompt: { text: string }[] }).prompt[0]!.text.split('\n\n')[0]!.split('\n');
  expect(block.slice(4)).toEqual([`/rooms/notes: ${room.repository}`]);
});

it("brings House's reference rewrites home when it finishes an expired rename House applied", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.dropsEdits = 1;
  const lost = await shell(hosted, `cd ${room.repository} && git mv library/a.md library/b.md && git commit -qm move && house git push`);
  hosted.tools.edit = () => ({ isError: true, content: [{ type: 'text', text: 'operation_expired: this operation is over 7 days old and its outcome is gone; read the current files and send again\n' }] });

  const finished = await shell(hosted, `cd ${room.repository} && house git push`);

  expect(lost.stderr).toContain('did not arrive');
  expect(finished).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}; main is at [0-9a-f]{12}\.\n$/) });
  expect(room.batches).toHaveLength(1);
  expect(await readFile(join(room.repository, 'library/index.md'), 'utf8')).toBe('See [alpha](b.md).\n');
  expect(git(room.repository, 'status', '--porcelain')).toBe('');
});
