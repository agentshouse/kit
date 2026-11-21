import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GIT_IDENTITY, hostKit, type Hosted } from './environment.ts';
import { digest, house, manifestOf, serveRooms, upload, type Room } from './rooms.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const COVER = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66]);
const KIT_MADE = ['refs/house', 'house-uploads'];

function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout;
}

async function put(path: string, content: string | Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

async function gitState(repository: string): Promise<Record<string, string>> {
  const folder = join(repository, '.git');
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1));
  const kept = files.filter((path) => !KIT_MADE.some((made) => path === made || path.startsWith(`${made}/`))).sort();
  return Object.fromEntries(await Promise.all(kept.map(async (path) => [path, digest(await readFile(join(folder, path)))] as const)));
}

it("converts a copy an earlier Kit kept as a Git repository once, keeping its working files, leaving its .git unread, and removing only what Kit wrote", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  const plan = room.put('plan.md', 'one\ntwo\n');
  const memo = room.put('memo.md', 'memo\n');
  const before = room.put('behind.md', 'behind, first\n');
  const behind = room.put('behind.md', 'behind, second\n');
  room.put('capture/mail/one.md', 'one\n', 'source: s_mail\n');
  const photo = room.upload('photo.jpg', JPEG);
  room.upload('cover.jpg', COVER);
  const position = room.position;
  rooms.answered = [room];
  const repository = room.repository;
  await put(join(repository, 'plan.md'), 'one\ntwo\nmine, not pushed\n');
  await put(join(repository, 'memo.md'), 'memo\n');
  await put(join(repository, 'behind.md'), 'behind, first\n');
  await put(join(repository, 'capture/mail/one.md'), 'one\n');
  await put(join(repository, 'capture/mail/_provenance/one.md'), 'source: s_mail\n');
  await put(join(repository, 'photo.jpg'), JPEG);
  await put(join(repository, '.gitignore'), '# Kit writes this file and .ignore.\n/.gitignore\n/.ignore\n/capture\n');
  await put(join(repository, '.ignore'), '!/capture\n');
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', 'plan.md', 'memo.md', 'behind.md', 'photo.jpg');
  git(repository, 'commit', '-q', '-m', 'House /rooms/notes');
  git(repository, 'update-ref', 'refs/house/received', 'HEAD');
  await mkdir(join(repository, '.git', 'house-uploads'));
  const held = await gitState(repository);
  const record = join(hosted.home, 'local-copies', 'rooms', `${room.ref}.json`);
  await put(
    record,
    JSON.stringify({
      key: `rooms/${room.ref}`,
      room_ref: room.ref,
      room_handle: 'notes',
      repository,
      house: 'c'.repeat(40),
      position: String(position),
      log_epoch: room.logEpoch,
      write: [''],
      protected: ['capture', 'collaboration'],
      read_only: ['capture/mail/one.md', 'capture/mail/_provenance/one.md'],
      manifests: {
        ['b'.repeat(40)]: {
          parent: null,
          files: { 'plan.md': plan, 'memo.md': memo, 'behind.md': before, 'photo.jpg': photo },
          binary: { 'photo.jpg': { bytes: JPEG.length, sha256: digest(JPEG) } },
        },
        ['c'.repeat(40)]: { parent: 'b'.repeat(40), files: { 'behind.md': behind } },
      },
      moves: [],
      push: { state: 'submitted', changes: [{ op: 'replace', path: '/rooms/notes/plan.md' }] },
    }),
  );
  room.put('memo.md', 'memo, from House\n');
  await hosted.restart();

  const downloaded = await house(hosted, '/', 'download');

  expect(downloaded).toEqual({ status: 0, stdout: '/rooms/notes: 1 file updated from House\n', stderr: '' });
  expect((await readdir(repository)).sort()).toEqual(['.git', '.house', 'behind.md', 'capture', 'memo.md', 'photo.jpg', 'plan.md']);
  expect(await readFile(join(repository, 'plan.md'), 'utf8')).toBe('one\ntwo\nmine, not pushed\n');
  expect(await readFile(join(repository, 'memo.md'), 'utf8')).toBe('memo, from House\n');
  expect(await readFile(join(repository, 'behind.md'), 'utf8')).toBe('behind, second\n');
  expect(existsSync(join(repository, '.git', 'refs', 'house'))).toBe(false);
  expect(existsSync(join(repository, '.git', 'house-uploads'))).toBe(false);
  expect(await gitState(repository)).toEqual(held);
  expect(await manifestOf(room)).toEqual({
    room_ref: room.ref,
    files: {
      'behind.md': { revision: behind, sha256: digest('behind, second\n'), bytes: 15 },
      'capture/mail/_provenance/one.md': expect.objectContaining({ read_only: true, sha256: digest('source: s_mail\n') }),
      'capture/mail/one.md': expect.objectContaining({ read_only: true, sha256: digest('one\n') }),
      'cover.jpg': { revision: room.revision('cover.jpg'), sha256: digest(COVER), bytes: COVER.length, skipped: true },
      'memo.md': { revision: room.revision('memo.md'), sha256: digest('memo, from House\n'), bytes: 17 },
      'photo.jpg': { revision: photo, sha256: digest(JPEG), bytes: JPEG.length },
      'plan.md': { revision: plan, sha256: digest('one\ntwo\n'), bytes: 8 },
    },
  });
  const converted = JSON.parse(await readFile(record, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(converted).sort()).toEqual(['key', 'log_epoch', 'position', 'protected', 'repository', 'room_handle', 'room_ref', 'write']);

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n', stderr: '' });
  const sent = hosted.house.requests.filter((request) => request.path === '/kit/door/update').map((request) => (request.body as { changes: unknown }).changes);
  expect(sent).toEqual([[{ op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\nmine, not pushed\n', base: plan }]]);
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\nmine, not pushed\n');
  expect(git(repository, 'log', '--format=%s')).toBe('House /rooms/notes\n');
});

async function earlierCopy(hosted: Hosted, room: Room, files: Record<string, string>, manifests: string[][]): Promise<string> {
  for (const [path, content] of Object.entries(files)) await put(join(room.repository, path), content);
  git(room.repository, 'init', '-q', '-b', 'main');
  git(room.repository, 'add', '-A');
  git(room.repository, 'commit', '-q', '-m', 'House /rooms/notes');
  const commits = manifests.map((_, index) => String(index + 1).repeat(40));
  const record = join(hosted.home, 'local-copies', 'rooms', `${room.ref}.json`);
  await put(
    record,
    JSON.stringify({
      key: `rooms/${room.ref}`,
      room_ref: room.ref,
      room_handle: room.handle,
      repository: room.repository,
      house: commits.at(-1),
      position: String(room.position),
      log_epoch: room.logEpoch,
      write: [''],
      protected: ['capture', 'collaboration'],
      read_only: [],
      manifests: Object.fromEntries(
        manifests.map((pairs, index) => [commits[index], { parent: index === 0 ? null : commits[index - 1], files: Object.fromEntries(pairs.map((pair) => pair.split('='))) }]),
      ),
      moves: [],
    }),
  );
  return record;
}

it('keeps a copy an earlier Kit kept unconverted when House does not answer a revision it reads, says why, and converts it on the next download', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  const plan = room.put('plan.md', 'one\n');
  rooms.answered = [room];
  const record = await earlierCopy(hosted, room, { 'plan.md': 'one\n' }, [[`plan.md=${plan}`]]);
  room.put('plan.md', 'one, later\n');
  await hosted.restart();
  rooms.refusesReads = [
    { status: 503, body: { error: { code: 'house_unavailable', message: 'house_unavailable: House is unavailable; call again shortly', retryable: true } } },
  ];

  expect(await house(hosted, '/', 'download')).toEqual({
    status: 1,
    stdout: '',
    stderr:
      'house: /rooms/notes: Kit could not convert the copy an earlier Kit kept yet (house_unavailable: House is unavailable; call again shortly); the next house download or house upload converts it\n',
  });
  expect(JSON.parse(await readFile(record, 'utf8'))).toHaveProperty('manifests');
  expect(existsSync(join(room.repository, '.house'))).toBe(false);

  expect(await house(hosted, '/', 'download')).toEqual({ status: 0, stdout: '/rooms/notes: 1 file updated from House\n', stderr: '' });
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe('one, later\n');
  expect(JSON.parse(await readFile(record, 'utf8'))).not.toHaveProperty('manifests');
});

it('takes as the base of a file edited on an older received revision the revision the earlier record holds closest to it, so House merges the change the copy never brought', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  const first = room.put('plan.md', 'one\ntwo\nthree\nfour\nfive\n');
  const second = room.put('plan.md', 'ONE\ntwo\nthree\nfour\nfive\n');
  rooms.answered = [room];
  await earlierCopy(hosted, room, { 'plan.md': 'one\ntwo\nthree\nfour\nFIVE, mine\n' }, [[`plan.md=${first}`], [`plan.md=${second}`]]);
  await hosted.restart();

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n', stderr: '' });

  const sent = hosted.house.requests.filter((request) => request.path === '/kit/door/update').map((request) => (request.body as { changes: unknown }).changes);
  expect(sent).toEqual([[{ op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\nthree\nfour\nFIVE, mine\n', base: first }]]);
  expect(room.files.get('plan.md')!.content).toBe('ONE\ntwo\nthree\nfour\nFIVE, mine\n');
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE, mine\n');
});
