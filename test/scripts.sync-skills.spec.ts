import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { temporaryHome } from './kit.ts';

const SYNC = fileURLToPath(new URL('../scripts/sync-skills.mjs', import.meta.url));

async function place(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function git(root: string, argv: string[], date = '2026-10-09T23:30:00-02:00'): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Upstream', '-c', 'user.email=upstream@example.com', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

async function upstream(): Promise<string> {
  const root = await temporaryHome();
  git(root, ['init', '--quiet', '--initial-branch', 'main']);
  await place(root, {
    LICENSE: 'MIT License, upstream\n',
    'README.md': 'not a skill\n',
    'skills/engineering/README.md': 'not a skill either\n',
    'skills/engineering/tdd/SKILL.md': '---\nname: tdd\ndisable-model-invocation: true\n---\n\nRed, then green.\n',
    'skills/engineering/tdd/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
    'skills/engineering/triage/SKILL.md': '---\nname: triage\n---\n',
    'skills/engineering/licensed/SKILL.md': '---\nname: licensed\n---\n',
    'skills/engineering/licensed/LICENSE': 'its own license\n',
    'skills/engineering/setup-matt-pocock-skills/SKILL.md': '---\nname: setup-matt-pocock-skills\n---\n',
    'skills/productivity/grill-me/SKILL.md': '---\nname: grill-me\n---\n',
    'skills/misc/scaffold-exercises/SKILL.md': '---\nname: scaffold-exercises\n---\n',
    'skills/in-progress/loop-me/SKILL.md': '---\nname: loop-me\n---\n',
    'skills/deprecated/README.md': 'gone\n',
  });
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '--message', 'upstream']);
  return root;
}

async function kit(): Promise<string> {
  const root = await temporaryHome();
  await place(root, {
    'skills/resolving-merge-conflicts/SKILL.md': 'an earlier upstream skill\n',
    'skills/tdd/SKILL.md': '---\nname: tdd\n---\n\n<!-- Vendored from mattpocock/skills at commit c55ee46 -->\n',
    'skills-upstream.json': '{"commit":"c55ee46"}\n',
    'package.json': '{}\n',
  });
  return root;
}

function sync(root: string, repository: string): string {
  return execFileSync(process.execPath, [SYNC, repository], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => !entry.isDirectory()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [file, await readFile(join(root, file), 'utf8')])));
}

it("replaces the skill set with upstream main's engineering and productivity skills but setup, verbatim, each beside upstream's license", async () => {
  const source = await upstream();
  const root = await kit();
  const repository = `file://${source}`;

  sync(root, repository);

  const files = await snapshot(source);
  expect(await snapshot(join(root, 'skills'))).toEqual({
    'grill-me/LICENSE': 'MIT License, upstream\n',
    'grill-me/SKILL.md': files['skills/productivity/grill-me/SKILL.md'],
    'licensed/LICENSE': 'its own license\n',
    'licensed/SKILL.md': files['skills/engineering/licensed/SKILL.md'],
    'tdd/LICENSE': 'MIT License, upstream\n',
    'tdd/SKILL.md': files['skills/engineering/tdd/SKILL.md'],
    'tdd/agents/openai.yaml': files['skills/engineering/tdd/agents/openai.yaml'],
    'triage/LICENSE': 'MIT License, upstream\n',
    'triage/SKILL.md': files['skills/engineering/triage/SKILL.md'],
  });
  expect(JSON.parse(await readFile(join(root, 'skills-upstream.json'), 'utf8'))).toEqual({
    repository,
    commit: git(source, ['rev-parse', 'HEAD']),
    date: '2026-10-10',
  });
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{}\n');
});

it('changes nothing when run again on the same upstream commit', async () => {
  const source = await upstream();
  const root = await kit();
  sync(root, `file://${source}`);
  const first = await snapshot(root);

  sync(root, `file://${source}`);

  expect(await snapshot(root)).toEqual(first);
});

it('follows upstream main as it moves: a dropped skill leaves, an added one arrives, and the record names the new commit', async () => {
  const source = await upstream();
  const root = await kit();
  sync(root, `file://${source}`);
  await rm(join(source, 'skills', 'engineering', 'triage'), { recursive: true });
  await place(source, { 'skills/engineering/pr/SKILL.md': '---\nname: pr\n---\n' });
  git(source, ['add', '--all']);
  git(source, ['commit', '--quiet', '--message', 'moved on'], '2026-10-12T08:00:00Z');

  sync(root, `file://${source}`);

  expect((await readdir(join(root, 'skills'))).sort()).toEqual(['grill-me', 'licensed', 'pr', 'tdd']);
  expect(JSON.parse(await readFile(join(root, 'skills-upstream.json'), 'utf8'))).toMatchObject({
    commit: git(source, ['rev-parse', 'HEAD']),
    date: '2026-10-12',
  });
});
