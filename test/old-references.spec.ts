import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostKit, type Hosted } from './environment.ts';
import { commitAll, git, house, serveRooms, type Room, type Rooms } from './rooms.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const REDRAWN = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66]);
const REVISION = /^v_(\w+)\.\w+\.(\w)$/;
const HELD_REVISION = /"v_(\w+\.\w+\.\w)"/g;
const OLD_FORM = /"(?:fr|af)_\w/;

interface CopyRecord {
  house: string;
  manifests: { [commit: string]: { parent: string | null; files: { [path: string]: string | null } } };
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

function recordOf(hosted: Hosted, room: Room): string {
  return join(hosted.home, 'local-copies/rooms', `${room.ref}.json`);
}

function earlierForms(text: string): string {
  return text.replace(HELD_REVISION, '"fr_$1"');
}

async function earlier(hosted: Hosted, room: Room): Promise<void> {
  const path = recordOf(hosted, room);
  await writeFile(path, earlierForms(await readFile(path, 'utf8')));
}

function referenced(text: string, prefixes: { [path: string]: string }): string {
  const record = JSON.parse(text) as CopyRecord;
  for (const [commit, manifest] of Object.entries(record.manifests)) {
    if (commit === record.house) continue;
    for (const [path, prefix] of Object.entries(prefixes)) {
      const revision = manifest.files[path];
      if (typeof revision === 'string') manifest.files[path] = revision.replace(REVISION, `${prefix}$1.$2`);
    }
  }
  return JSON.stringify(record);
}

function batches(hosted: Hosted, from = 0): { operation_id: string; changes: Record<string, unknown>[] }[] {
  return hosted.house.requests
    .slice(from)
    .filter((request) => request.path === '/kit/door/update')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

function sent(hosted: Hosted, from: number): string {
  return JSON.stringify(hosted.house.requests.slice(from).map((request) => request.body));
}

async function copied(): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('plan.md', 'one\n');
  room.put('notes.md', 'notes\n');
  await rooms.fetch([room]);
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
  await writeFile(join(room.repository, 'cover.jpg'), JPEG);
  await writeFile(join(room.repository, 'photo.jpg'), REDRAWN);
  commitAll(room.repository, 'attachments');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  return { hosted, rooms, room };
}

it("rewrites the fr_ revisions and af_ references an earlier Kit's Local copy record holds, by each Path's kind, before it sends House anything, pushes on them, and leaves the rewritten record as it is when it starts again", async () => {
  const { hosted, room } = await copied();
  room.put('plan.md', 'one\ntwo\n');
  room.upload('cover.jpg', REDRAWN);
  expect((await house(hosted, '/', 'fetch')).status).toBe(0);
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');
  const path = recordOf(hosted, room);
  const written = await readFile(path, 'utf8');
  await writeFile(path, earlierForms(referenced(written, { 'plan.md': 'af_', 'cover.jpg': 'af_' })));
  const asked = hosted.house.requests.length;

  await hosted.restart();

  expect(await readFile(path, 'utf8')).toBe(referenced(written, { 'plan.md': 'd_', 'cover.jpg': 'at_' }));
  await rm(join(room.repository, 'plan.md'));
  await writeFile(join(room.repository, 'cover.jpg'), JPEG);
  const commit = commitAll(room.repository, 'three');
  const bases = { plan: room.revision('plan.md'), cover: room.binaries.get('cover.jpg')!.revision };

  expect(await house(hosted, room.repository, 'push', '--owner')).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted, asked)[0]!.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: 'upload', path: '/rooms/notes/cover.jpg', base: bases.cover }),
      { op: 'remove', path: '/rooms/notes/plan.md', base: bases.plan },
    ]),
  );
  expect(room.files.has('plan.md')).toBe(false);
  expect(room.binaries.get('cover.jpg')!.bytes).toEqual(JPEG);
  expect(sent(hosted, asked)).not.toMatch(OLD_FORM);

  const rewritten = await readFile(path, 'utf8');
  await hosted.restart();

  expect(await readFile(path, 'utf8')).toBe(rewritten);
});

it('sends a push an earlier Kit left unanswered again under its operation with the base of each change in v_, and House lands it', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\n\n## Next\n\ntwo\n');
  await rm(join(room.repository, 'notes.md'));
  await mkdir(join(room.repository, 'art'));
  git(room.repository, 'mv', 'cover.jpg', 'art/cover.jpg');
  await writeFile(join(room.repository, 'photo.jpg'), JPEG);
  const commit = commitAll(room.repository, 'two');
  rooms.refusesBatches = [{ drop: true }];
  expect((await house(hosted, room.repository, 'push', '--owner')).stderr).toContain(`House's answer to ${short(commit)} did not arrive`);
  const [lost] = batches(hosted).slice(-1);
  expect(lost!.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ op: 'replace', path: '/rooms/notes/plan.md', base: expect.stringMatching(/^v_/) }),
      expect.objectContaining({ op: 'remove', path: '/rooms/notes/notes.md', base: expect.stringMatching(/^v_/) }),
      expect.objectContaining({ op: 'rename', path: '/rooms/notes/cover.jpg', to: '/rooms/notes/art/cover.jpg', base: expect.stringMatching(/^v_/) }),
      expect.objectContaining({ op: 'upload', path: '/rooms/notes/photo.jpg', base: expect.stringMatching(/^v_/) }),
    ]),
  );
  await earlier(hosted, room);
  const asked = hosted.house.requests.length;

  await hosted.restart();
  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  const resent = batches(hosted, asked);
  expect(resent.length).toBeGreaterThan(0);
  expect(resent.every((batch) => batch.operation_id === lost!.operation_id)).toBe(true);
  expect(resent[0]!.changes).toEqual(lost!.changes);
  expect(room.files.get('plan.md')!.content).toBe('one\n\n## Next\n\ntwo\n');
  expect(room.files.has('notes.md')).toBe(false);
  expect(room.binaries.get('art/cover.jpg')!.bytes).toEqual(JPEG);
  expect(room.binaries.get('photo.jpg')!.bytes).toEqual(JPEG);
  expect(sent(hosted, asked)).not.toMatch(OLD_FORM);
});

it('finishes a push House accepted for an earlier Kit with the revisions House answered rewritten into v_, and the next push sends them as its bases', async () => {
  const { hosted, rooms, room } = await copied();
  await mkdir(join(room.repository, 'art'));
  git(room.repository, 'mv', 'cover.jpg', 'art/cover.jpg');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\n');
  const commit = commitAll(room.repository, 'moved');
  rooms.unreadable.add(room.ref);
  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({
    status: 0,
    stdout: `House accepted ${short(commit)}; run house push again to finish integrating it here\n`,
  });
  await earlier(hosted, room);
  rooms.unreadable.clear();
  const asked = hosted.house.requests.length;

  await hosted.restart();

  expect(await house(hosted, room.repository, 'push', '--owner')).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\n');
  await writeFile(join(room.repository, 'art/cover.jpg'), REDRAWN);
  const next = commitAll(room.repository, 'three');
  expect(await house(hosted, room.repository, 'push', '--owner')).toEqual({ status: 0, stdout: `House accepted ${short(next)}.\n`, stderr: '' });
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\nthree\n');
  expect(room.binaries.get('art/cover.jpg')!.bytes).toEqual(REDRAWN);
  expect(sent(hosted, asked)).not.toMatch(OLD_FORM);
});
