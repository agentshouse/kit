import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { house, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const PROTECTED = 'protected_path: rooms/notebook/capture/x.md is not writable';

const LIMITED = "limit_reached: you reached today's Write limit; try again at 2026-11-17T00:00:00.000Z";

const MARKDOWN = 'it is Markdown, which holds text only: UTF-8 without NUL, at most 1000000 bytes';

function batches(hosted: Hosted): { operation_id: string; changes: Record<string, unknown>[] }[] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/update')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

function outside(hosted: Hosted): unknown[] {
  return hosted.unsaved.filter((received) => received.path === '/kit/local-copies/not-saved/report').map((received) => received.body);
}

async function record(hosted: Hosted, room: Room): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')) as Record<string, unknown>;
}

async function copied(): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('plan.md', 'one\ntwo\nthree\n');
  expect(await rooms.download([room])).toMatchObject({ status: 0 });
  return { hosted, rooms, room };
}

it("lands the files House accepts of a batch it refuses for one file under a new operation id, keeps that file pending with House's line, sends it again with the next upload, and reports it outside any turn once for each reason", async () => {
  const { hosted, room } = await copied();
  const plan = room.revision('plan.md');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\nfour\n');
  await mkdir(join(room.repository, 'capture'));
  await writeFile(join(room.repository, 'capture', 'x.md'), 'held\n');
  const refused = { room_ref: room.ref, path: 'rooms/notebook/capture/x.md', refused: PROTECTED };

  expect(await upload(hosted, room)).toEqual({
    status: 1,
    stdout: '',
    stderr: `house: House accepted 1 file of rooms/notebook.\nrooms/notebook/capture/x.md: not saved: ${PROTECTED}\n`,
  });

  const sent = batches(hosted);
  const four = { op: 'write', path: 'rooms/notebook/plan.md', content: 'one\ntwo\nthree\nfour\n', base: plan };
  const held = { op: 'write', path: 'rooms/notebook/capture/x.md', content: 'held\n' };
  expect(sent.map((batch) => batch.changes)).toEqual([[held, four], [four]]);
  expect(sent[1]!.operation_id).not.toBe(sent[0]!.operation_id);
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\nthree\nfour\n');
  expect(room.files.has('capture/x.md')).toBe(false);
  expect(await readFile(join(room.repository, 'capture', 'x.md'), 'utf8')).toBe('held\n');
  expect(await record(hosted, room)).toMatchObject({ refused: { 'capture/x.md': PROTECTED } });
  expect(outside(hosted)).toEqual([refused]);

  expect(await upload(hosted, room)).toEqual({ status: 1, stdout: '', stderr: `house: rooms/notebook/capture/x.md: not saved: ${PROTECTED}\n` });
  expect(batches(hosted).slice(2).map((batch) => batch.changes)).toEqual([[held]]);
  expect(outside(hosted)).toEqual([refused]);

  await writeFile(join(room.repository, 'capture', 'x.md'), Buffer.from([0xff, 0xfe, 0x00]));
  expect(await upload(hosted, room)).toEqual({ status: 1, stdout: '', stderr: `house: rooms/notebook/capture/x.md: not saved: ${MARKDOWN}\n` });
  expect(batches(hosted)).toHaveLength(3);
  expect(outside(hosted)).toEqual([refused, { ...refused, refused: MARKDOWN }]);
  expect(MARKDOWN).not.toMatch(/house (upload|download)/);

  await rm(join(room.repository, 'capture', 'x.md'));
  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'Nothing to upload: rooms/notebook matches House.\n', stderr: '' });
  expect(outside(hosted)).toHaveLength(2);
  expect(await record(hosted, room)).not.toHaveProperty('refused');
  expect(await record(hosted, room)).not.toHaveProperty('reported');
});

it('keeps the whole change set pending with the reason of a refusal that names no file, reports each file of it once, and the next upload lands it', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\nfour\n');
  await writeFile(join(room.repository, 'new.md'), 'new\n');
  rooms.writeUnits = 0;

  const stopped = await upload(hosted, room);

  expect(stopped.status).toBe(1);
  expect(stopped.stderr).toContain(LIMITED);
  expect(await record(hosted, room)).toMatchObject({
    refused: { 'new.md': LIMITED, 'plan.md': LIMITED },
    pending: { changes: [{ path: 'rooms/notebook/new.md' }, { path: 'rooms/notebook/plan.md' }] },
  });
  expect(outside(hosted)).toEqual([
    { room_ref: room.ref, path: 'rooms/notebook/new.md', refused: LIMITED },
    { room_ref: room.ref, path: 'rooms/notebook/plan.md', refused: LIMITED },
  ]);
  expect((await upload(hosted, room)).status).toBe(1);
  expect(outside(hosted)).toHaveLength(2);

  rooms.writeUnits = Infinity;
  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 2 files of rooms/notebook.\n', stderr: '' });
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  expect(room.files.get('new.md')!.content).toBe('new\n');
  expect(await record(hosted, room)).not.toHaveProperty('refused');
  expect(outside(hosted)).toHaveLength(2);
});

it('reports a file holding conflict markers that house upload leaves in a Room folder outside any turn once, and nothing once it is resolved', async () => {
  const { hosted, room } = await copied();
  room.put('plan.md', 'one\nTWO, theirs\nthree\n');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo, mine\nthree\n');

  expect((await upload(hosted, room)).status).toBe(1);
  expect((await upload(hosted, room)).status).toBe(1);
  expect(outside(hosted)).toEqual([{ room_ref: room.ref, path: 'rooms/notebook/plan.md', markers: true }]);

  await writeFile(join(room.repository, 'plan.md'), 'one\nTWO, both\nthree\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of rooms/notebook.\n' });
  expect(outside(hosted)).toHaveLength(1);
  expect(await record(hosted, room)).not.toHaveProperty('reported');
});

it("reports a file house upload leaves refused in a deleted conversation's copy outside any turn, once for each reason", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notebook');
  notes.put('plan.md', 'Plant beans\n');
  rooms.answered = [notes];
  await rooms.download([notes]);
  hosted.call({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1', room_ref: notes.ref, name: 'Plan' });
  await hosted.result(lastCall());
  const copy = join(hosted.workspace, 'conversations', 'notebook', 'Plan');
  hosted.call({ kind: 'message', conversation_id: 'conversation-1', agent_id: 'agent-1', text: '@sh mkdir -p capture && echo held > capture/x.md', first: false });
  await until(() => hosted.unsaved.find((received) => received.path === '/kit/turns/not-saved/report'));
  hosted.call({ kind: 'kill', conversation_id: 'conversation-1', agent_id: 'agent-1', deleted: true });
  expect(await hosted.result(lastCall())).toEqual({ kept: [{ room_ref: notes.ref, path: copy }] });

  expect(await house(hosted, copy, 'upload')).toEqual({ status: 1, stdout: '', stderr: `house: rooms/notebook/capture/x.md: not saved: ${PROTECTED}\n` });
  expect((await house(hosted, copy, 'upload')).status).toBe(1);

  expect(outside(hosted)).toEqual([{ room_ref: notes.ref, path: 'rooms/notebook/capture/x.md', refused: PROTECTED }]);
});
