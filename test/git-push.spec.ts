import { parse } from '@agentshouse/mdmodel';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { GIT_IDENTITY, hostKit, type Hosted } from './environment.ts';
import { fakeBin, runKit } from './kit.ts';
import { commitAll, git, house, serveRooms, tryGit, type Room, type Rooms } from './rooms.ts';

const MEMO = [
  '---',
  'type: memo',
  'owner: ada',
  'status: draft',
  '---',
  'Opening words.',
  '',
  '## Goals',
  '',
  'Grow.',
  '',
  '## Risks',
  '',
  'None yet.',
  '',
].join('\n');

async function copied(): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('ROOM.md', 'The notes Room\n');
  room.put('docs/plan.md', 'one\ntwo\n');
  room.put('docs/memo.md', MEMO);
  room.put('capture/mail/one.md', 'one\n');
  await rooms.select([room]);
  return { hosted, rooms, room };
}

function batches(hosted: Hosted): { operation_id: string; changes: Record<string, unknown>[] }[] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/batch')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

function head(room: Room): string {
  return git(room.repository, 'rev-parse', 'HEAD').trim();
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

it('sends the selected commit, HEAD by default, as exact-base edits and leaves staged and unstaged work local', async () => {
  const { hosted, room } = await copied();
  const memo = room.revision('docs/memo.md');
  await writeFile(join(room.repository, 'docs/plan.md'), 'one\ntwo\nthree\n');
  await writeFile(join(room.repository, 'docs/new.md'), 'new\n');
  const first = commitAll(room.repository, 'first');
  await writeFile(join(room.repository, 'docs/memo.md'), `${MEMO}\n## Notes\n\nA new section.\n`);
  const second = commitAll(room.repository, 'second');
  await writeFile(join(room.repository, 'docs/new.md'), 'new, staged\n');
  git(room.repository, 'add', 'docs/new.md');
  await writeFile(join(room.repository, 'docs/plan.md'), 'unstaged\n');

  const pushed = await house(hosted, join(room.repository, 'docs'), 'push', first, '--owner');

  expect(pushed).toMatchObject({ status: 0, stdout: `House accepted ${short(first)}.\n` });
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [
      { op: 'create', path: '/rooms/notes/docs/new.md', content: 'new\n' },
      { op: 'replace_preamble', path: '/rooms/notes/docs/plan.md', base: 'one\ntwo\n', content: 'one\ntwo\nthree\n' },
    ],
  ]);
  expect(room.files.get('docs/memo.md')!.content).toBe(MEMO);

  const again = await house(hosted, room.repository, 'push', '--owner');

  expect(again).toMatchObject({ status: 0, stdout: `House accepted ${short(second)}.\n` });
  expect(batches(hosted)[1]!.changes).toEqual([
    { op: 'replace', path: '/rooms/notes/docs/memo.md', base: memo, content: `${MEMO}\n## Notes\n\nA new section.\n` },
  ]);
  expect(room.files.get('docs/plan.md')!.content).toBe('one\ntwo\nthree\n');
  expect(room.files.get('docs/memo.md')!.content).toBe(`${MEMO}\n## Notes\n\nA new section.\n`);
  expect(head(room)).toBe(second);
  expect(git(room.repository, 'show', ':docs/new.md')).toBe('new, staged\n');
  expect(await readFile(join(room.repository, 'docs/plan.md'), 'utf8')).toBe('unstaged\n');

  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({
    status: 0,
    stdout: `Nothing to submit: ${short(second)} matches House.\n`,
  });
  expect(batches(hosted)).toHaveLength(2);
});

it('sends a changed schema as one whole-text replacement against its revision', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('private');
  room.protected = ['agents', 'house'];
  const schema = 'types:\n  note:\n    fields:\n      title: { kind: string }\n';
  room.put('settings/schema.yaml', schema);
  await rooms.select([room]);
  const revision = room.revision('settings/schema.yaml');
  const widened = `${schema}      status: { kind: string }\n`;
  await writeFile(join(room.repository, 'settings/schema.yaml'), widened);
  commitAll(room.repository, 'widen');

  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({ status: 0 });
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [{ op: 'replace', path: '/rooms/private/settings/schema.yaml', base: revision, content: widened }],
  ]);
  expect(room.files.get('settings/schema.yaml')!.content).toBe(widened);
});

it('sends a changed field, section and preamble against its own prior value, so different remote changes to the same file both stand', async () => {
  const { hosted, room } = await copied();
  const local = MEMO.replace('status: draft', 'status: ready').replace('Grow.', 'Grow fast.').replace('Opening words.', 'New opening.');
  await writeFile(join(room.repository, 'docs/memo.md'), local);
  const pushedCommit = commitAll(room.repository, 'memo');
  room.put('docs/memo.md', MEMO.replace('owner: ada', 'owner: grace').replace('None yet.', 'Scope creep.'));
  const before = parse(MEMO, 'docs/memo.md');
  const after = parse(local, 'docs/memo.md');
  if (!before.ok || !after.ok) throw new Error('the memo fixture does not parse');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(batches(hosted)[0]!.changes).toEqual([
    {
      op: 'replace_preamble',
      path: '/rooms/notes/docs/memo.md',
      base: before.document.preamble,
      content: after.document.preamble,
    },
    { op: 'set_field', path: '/rooms/notes/docs/memo.md', field: 'status', base: 'draft', value: 'ready' },
    {
      op: 'replace_section',
      path: '/rooms/notes/docs/memo.md',
      section: 'Goals',
      base: before.document.sections.Goals,
      content: after.document.sections.Goals,
    },
  ]);
  const canonical = [
    '---',
    'type: memo',
    'owner: grace',
    'status: ready',
    '---',
    'New opening.',
    '',
    '## Goals',
    '',
    'Grow fast.',
    '',
    '## Risks',
    '',
    'Scope creep.',
    '',
  ].join('\n');
  expect(room.files.get('docs/memo.md')!.content).toBe(canonical);
  expect(pushed.stdout).toMatch(new RegExp(`^House accepted ${short(pushedCommit)}; main is at [0-9a-f]{12}\\.\\n$`));
  expect(await readFile(join(room.repository, 'docs/memo.md'), 'utf8')).toBe(canonical);
  expect(tryGit(room.repository, 'merge-base', '--is-ancestor', pushedCommit, 'HEAD').status).toBe(0);
  expect(git(room.repository, 'rev-parse', 'HEAD')).toBe(git(room.repository, 'rev-parse', 'refs/house/received^2'));
  expect(git(room.repository, 'status', '--porcelain')).toBe('');
});

it('refuses a stale component or whole-file base as one batch, records House state on the House ref, and a native Git resolution then pushes', async () => {
  const { hosted, room } = await copied();
  await writeFile(join(room.repository, 'docs/memo.md'), MEMO.replace('Grow.', 'Grow mine.'));
  await writeFile(join(room.repository, 'ROOM.md'), 'Mine too\n');
  commitAll(room.repository, 'mine');
  room.put('docs/memo.md', MEMO.replace('Grow.', 'Grow theirs.'));

  const refused = await house(hosted, room.repository, 'push', '--owner');

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('edit_conflict');
  expect(refused.stderr).toContain("refs/house/received holds House's current state; rebase onto it and push again");
  expect(room.files.get('ROOM.md')!.content).toBe('The notes Room\n');
  expect(git(room.repository, 'show', 'refs/house/received:docs/memo.md')).toBe(MEMO.replace('Grow.', 'Grow theirs.'));
  expect(git(room.repository, 'show', 'HEAD:docs/memo.md')).toBe(MEMO.replace('Grow.', 'Grow mine.'));

  expect(tryGit(room.repository, 'rebase', 'refs/house/received').status).not.toBe(0);
  const resolved = `${MEMO.replace('Grow.', 'Grow theirs and mine.')}\n## Notes\n\nResolved.\n`;
  await writeFile(join(room.repository, 'docs/memo.md'), resolved);
  git(room.repository, 'add', 'docs/memo.md');
  git(room.repository, 'rebase', '--continue');
  const theirs = room.revision('docs/memo.md');
  room.put('docs/memo.md', MEMO.replace('Grow.', 'Grow theirs.').replace('Opening words.', 'Opening late.'));
  const late = room.revision('docs/memo.md');

  const stale = await house(hosted, room.repository, 'push', '--owner');

  expect(stale.status).toBe(1);
  expect(batches(hosted)[1]!.changes).toEqual([
    { op: 'replace_preamble', path: '/rooms/notes/ROOM.md', base: 'The notes Room\n', content: 'Mine too\n' },
    { op: 'replace', path: '/rooms/notes/docs/memo.md', base: theirs, content: resolved },
  ]);
  expect(room.files.get('ROOM.md')!.content).toBe('The notes Room\n');

  git(room.repository, 'rebase', 'refs/house/received');
  const merged = resolved.replace('Opening words.', 'Opening late.');
  expect(await readFile(join(room.repository, 'docs/memo.md'), 'utf8')).toBe(merged);
  const retried = await house(hosted, room.repository, 'push', '--owner');

  expect(retried).toMatchObject({ status: 0, stdout: `House accepted ${short(head(room))}.\n` });
  expect(batches(hosted)[2]!.changes).toEqual([
    { op: 'replace_preamble', path: '/rooms/notes/ROOM.md', base: 'The notes Room\n', content: 'Mine too\n' },
    { op: 'replace', path: '/rooms/notes/docs/memo.md', base: late, content: merged },
  ]);
  expect(room.files.get('docs/memo.md')!.content).toBe(merged);
  expect(room.files.get('ROOM.md')!.content).toBe('Mine too\n');
});

it('refuses a change to a read-only path whatever the ignore file says and changes nothing in House', async () => {
  const { hosted, room } = await copied();
  await writeFile(join(room.repository, '.gitignore'), '');
  await writeFile(join(room.repository, 'capture/mail/one.md'), 'forged\n');
  await writeFile(join(room.repository, 'docs/plan.md'), 'one\n');
  git(room.repository, 'add', '-f', 'capture/mail/one.md', 'docs/plan.md');
  git(room.repository, 'commit', '-q', '-m', 'forged');

  const refused = await house(hosted, room.repository, 'push', '--owner');

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('protected_path');
  expect(refused.stderr).not.toContain('refs/house/received');
  expect(room.files.get('capture/mail/one.md')!.content).toBe('one\n');
  expect(room.files.get('docs/plan.md')!.content).toBe('one\ntwo\n');
});

it("brings House's result into the branch by fast-forward or a rebase of later commits, and leaves it pending on dirty work or a moved branch", async () => {
  const { hosted, room } = await copied();
  room.put('docs/memo.md', MEMO.replace('owner: ada', 'owner: grace'));
  await writeFile(join(room.repository, 'docs/memo.md'), MEMO.replace('status: draft', 'status: ready'));
  const pushedCommit = commitAll(room.repository, 'memo');
  await writeFile(join(room.repository, 'docs/later.md'), 'later\n');
  const later = commitAll(room.repository, 'later');

  const rebased = await house(hosted, room.repository, 'push', pushedCommit, '--owner');

  expect(rebased.stdout).toMatch(new RegExp(`^House accepted ${short(pushedCommit)}; main is at [0-9a-f]{12}\\.\\n$`));
  expect(head(room)).not.toBe(later);
  expect(git(room.repository, 'log', '--format=%s', 'refs/house/received^2..HEAD').trim()).toBe('later');
  expect(await readFile(join(room.repository, 'docs/memo.md'), 'utf8')).toContain('owner: grace');
  expect(await readFile(join(room.repository, 'docs/memo.md'), 'utf8')).toContain('status: ready');

  room.put('docs/memo.md', room.files.get('docs/memo.md')!.content.replace('type: memo', 'type: memo\nteam: core'));
  const memo = await readFile(join(room.repository, 'docs/memo.md'), 'utf8');
  await writeFile(join(room.repository, 'docs/memo.md'), memo.replace('status: ready', 'status: done'));
  const dirty = commitAll(room.repository, 'done');
  await writeFile(join(room.repository, 'docs/later.md'), 'dirty\n');

  const pending = await house(hosted, room.repository, 'push', '--owner');

  expect(pending.status).toBe(0);
  expect(pending.stdout).toMatch(new RegExp(`^House accepted ${short(dirty)}; local integration is pending \\(uncommitted changes\\): [0-9a-f]{40} holds House's result\\.\\n$`));
  expect(head(room)).toBe(dirty);
  expect(await readFile(join(room.repository, 'docs/later.md'), 'utf8')).toBe('dirty\n');
  expect(git(room.repository, 'stash', 'list')).toBe('');

  git(room.repository, 'checkout', '--', 'docs/later.md');
  const finished = await house(hosted, room.repository, 'push', '--owner');

  expect(finished.stdout).toMatch(new RegExp(`^House accepted ${short(dirty)}; main is at [0-9a-f]{12}\\.\\n$`));
  expect(await readFile(join(room.repository, 'docs/memo.md'), 'utf8')).toContain('team: core');
  expect(batches(hosted)).toHaveLength(2);

  room.put('docs/memo.md', room.files.get('docs/memo.md')!.content.replace('owner: grace', 'owner: hopper'));
  const current = await readFile(join(room.repository, 'docs/memo.md'), 'utf8');
  await writeFile(join(room.repository, 'docs/memo.md'), current.replace('status: done', 'status: shipped'));
  const moved = commitAll(room.repository, 'shipped');
  await writeFile(join(room.repository, 'docs/later.md'), 'dirty again\n');
  expect((await house(hosted, room.repository, 'push', '--owner')).stdout).toMatch(/pending \(uncommitted changes\)/);
  git(room.repository, 'checkout', '--', 'docs/later.md');
  git(room.repository, 'checkout', '-q', '-b', 'elsewhere');

  const elsewhere = await house(hosted, room.repository, 'push', '--owner');

  expect(elsewhere.stdout).toMatch(new RegExp(`^House accepted ${short(moved)}; local integration is pending \\(the branch changed\\)`));
  expect(git(room.repository, 'rev-parse', 'main').trim()).toBe(moved);
  expect(batches(hosted)).toHaveLength(3);
});

it('recovers an answer lost after House applied the push under the same operation and applies it once', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'docs/plan.md'), 'one\ntwo\nthree\n');
  const pushedCommit = commitAll(room.repository, 'three');
  rooms.dropping = 1;

  const lost = await house(hosted, room.repository, 'push', '--owner');

  expect(lost.status).toBe(1);
  expect(lost.stderr).toContain(`House's answer to ${short(pushedCommit)} did not arrive`);
  expect(room.batches).toHaveLength(1);

  await writeFile(join(room.repository, 'docs/unrelated.md'), 'unrelated\n');
  const recovered = await house(hosted, room.repository, 'push', '--owner');

  expect(recovered).toMatchObject({ status: 0, stdout: `House accepted ${short(pushedCommit)}.\n` });
  const [first, second] = batches(hosted);
  expect(second).toEqual(first);
  expect(room.batches).toHaveLength(1);
  expect(room.files.get('docs/plan.md')!.content).toBe('one\ntwo\nthree\n');
  expect(await readFile(join(room.repository, 'docs/unrelated.md'), 'utf8')).toBe('unrelated\n');
});

it('removes a file only through a committed deletion and sends a delete and add outside the shim as a removal and a creation', async () => {
  const { hosted, room } = await copied();
  const plan = room.revision('docs/plan.md');
  const memo = room.revision('docs/memo.md');
  await rm(join(room.repository, 'docs/plan.md'));

  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({
    status: 0,
    stdout: expect.stringMatching(/^Nothing to submit/),
  });
  expect(room.files.has('docs/plan.md')).toBe(true);

  git(room.repository, 'add', '-A');
  git(room.repository, 'mv', 'docs/memo.md', 'docs/renamed.md');
  git(room.repository, 'commit', '-q', '-m', 'remove and move');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed.status).toBe(0);
  expect(batches(hosted)[0]!.changes).toEqual([
    { op: 'remove', path: '/rooms/notes/docs/memo.md', base: memo },
    { op: 'remove', path: '/rooms/notes/docs/plan.md', base: plan },
    { op: 'create', path: '/rooms/notes/docs/renamed.md', content: MEMO },
  ]);
  expect(existsSync(join(room.repository, 'docs/plan.md'))).toBe(false);
});

it('pushes as the owner only with --owner outside a conversation and explains itself', async () => {
  const { hosted, room } = await copied();

  const bare = await house(hosted, room.repository, 'push');
  const help = await house(hosted, room.repository, 'push', '--help');
  const outside = await house(hosted, '/', 'push', '--owner');
  const old = await house(hosted, room.repository, 'git', 'push', '--owner');

  expect(bare).toMatchObject({ status: 1, stderr: 'house: outside an Agent conversation, house push needs --owner\n' });
  expect(help.status).toBe(0);
  expect(help.stdout).toBe('usage: house push [commit] [--owner]\n');
  expect(old.status).toBe(1);
  expect(old.stderr).not.toContain('push');
  expect(outside).toMatchObject({
    status: 1,
    stderr: 'house: / is not a House Local copy; run house push inside one\n',
  });
  expect(batches(hosted)).toEqual([]);
});

it('picks its copies up again when the resident starts anew', async () => {
  const { hosted, room } = await copied();
  process.kill(hosted.kit.pid, 'SIGKILL');
  await hosted.kit.exited;
  room.put('docs/memo.md', MEMO.replace('owner: ada', 'owner: grace'));
  runKit(['resident'], { HOUSE_KIT_HOME: hosted.home, PATH: await fakeBin(hosted.home), ...GIT_IDENTITY });
  await until(() => hosted.house.sockets[1]);
  await writeFile(join(room.repository, 'docs/plan.md'), 'one\ntwo\nthree\n');
  const pushedCommit = commitAll(room.repository, 'three');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toMatchObject({ status: 0, stdout: `House accepted ${short(pushedCommit)}.\n` });
  expect(room.files.get('docs/plan.md')!.content).toBe('one\ntwo\nthree\n');
  await until(() => git(room.repository, 'show', 'refs/house/received:docs/memo.md').includes('owner: grace'));
});

it('finishes a push whose operation expired when House holds its component changes beside a remote one', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'docs/memo.md'), MEMO.replace('status: draft', 'status: ready'));
  const pushedCommit = commitAll(room.repository, 'ready');
  room.put('docs/memo.md', MEMO.replace('owner: ada', 'owner: grace'));
  rooms.dropping = 1;
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(1);
  hosted.house.route('POST', '/kit/door/batch', () => ({ status: 410, body: { error: { code: 'operation_expired' } } }));

  const recovered = await house(hosted, room.repository, 'push', '--owner');

  expect(recovered.stdout).toMatch(new RegExp(`^House accepted ${short(pushedCommit)}; main is at [0-9a-f]{12}\\.\\n$`));
  expect(room.batches).toHaveLength(1);
  const memo = await readFile(join(room.repository, 'docs/memo.md'), 'utf8');
  expect(memo).toContain('owner: grace');
  expect(memo).toContain('status: ready');
});

it('keeps newer House text on the House ref when it finishes a push whose answer it recovers after delivery moved on', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'docs/plan.md'), 'one\ntwo\nmine\n');
  const pushedCommit = commitAll(room.repository, 'mine');
  rooms.dropping = 1;
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(1);
  room.put('docs/plan.md', 'one\ntwo\nmine\nlater\n');
  hosted.socket.send({ type: 'entries', authority: room.ref, position: String(room.position), log_epoch: room.logEpoch, entries: [] });
  await until(() => git(room.repository, 'show', 'refs/house/received:docs/plan.md') === 'one\ntwo\nmine\nlater\n');
  hosted.house.route('POST', '/kit/door/enumerate', () => ({ status: 503, body: { error: { code: 'house_unavailable' } } }));

  const recovered = await house(hosted, room.repository, 'push', '--owner');

  expect(recovered).toMatchObject({ status: 0, stdout: `House accepted ${short(pushedCommit)}.\n` });
  expect(git(room.repository, 'show', 'refs/house/received:docs/plan.md')).toBe('one\ntwo\nmine\nlater\n');
  expect(git(room.repository, 'show', 'refs/house/received^2:docs/plan.md')).toBe('one\ntwo\nmine\n');
  expect(room.batches).toHaveLength(1);
});

it('keeps a pushed operation whose outcome it could not yet read and finishes it later under the same operation', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'docs/plan.md'), 'one\ntwo\nthree\n');
  const pushedCommit = commitAll(room.repository, 'three');
  rooms.dropping = 1;
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(1);
  hosted.house.route('POST', '/kit/door/batch', () => ({ status: 410, body: { error: { code: 'operation_expired' } } }));
  rooms.reads = [true, false];

  const unread = await house(hosted, room.repository, 'push', '--owner');
  const finished = await house(hosted, room.repository, 'push', '--owner');

  expect(unread.status).toBe(1);
  expect(finished).toMatchObject({ status: 0, stdout: `House accepted ${short(pushedCommit)}.\n` });
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  expect(batches(hosted)).toHaveLength(3);
  expect(room.batches).toHaveLength(1);
});
