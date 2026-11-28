import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

const KIT = fileURLToPath(new URL('..', import.meta.url));
const OLD = '/' + 'rooms';
const BEGUN = new RegExp(String.raw`(?:(?<![\p{L}\p{N}_.~%$}-])|(?<=\\[nrt]))` + OLD + String.raw`(?![\p{L}\p{N}_-])`, 'u');

async function oldForms(root: string): Promise<string[]> {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((file) => file !== '');
  const found: string[] = [];
  for (const file of tracked) {
    const bytes = await readFile(join(root, file));
    if (bytes.includes(0)) continue;
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        if (BEGUN.test(line)) found.push(`${file}:${index + 1}`);
      });
  }
  return found;
}

it('holds a path beginning with a slash before rooms in no tracked file, so every file writes Room paths', async () => {
  expect(await oldForms(KIT)).toEqual([]);
});

it('refuses each planted path that begins with a slash before rooms and passes a web address, a port, a computer path, a later path segment and a Room path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kit-old-form-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), [`Open ${OLD}/notes-room/plan.md.`, 'A Room path is rooms/notes-room/plan.md.', ''].join('\n'));
  await writeFile(
    join(root, 'docs', 'paths.ts'),
    [`const path = '${OLD}/notes-room/a.md';`, `const all = "${OLD}";`, `const pattern = /^\\${OLD}\\//;`, `const lines = 'saved\\n${OLD}/notes-room/a.md';`, ''].join('\n'),
  );
  await writeFile(
    join(root, 'docs', 'kept.md'),
    [
      `https://agents.house${OLD}/notes-room/plan.md`,
      `http://localhost:8080${OLD}/notes-room/plan.md`,
      `~/house${OLD}/notes-room/plan.md`,
      `local-copies${OLD}/r_notes.json`,
      `\`\${origin}${OLD}/notes-room\``,
      `${OLD}-index and ${OLD}cape`,
      '',
    ].join('\n'),
  );
  await writeFile(join(root, 'untracked.md'), `${OLD}/notes-room/plan.md\n`);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'README.md', 'docs'], { cwd: root });

  expect(await oldForms(root)).toEqual(['README.md:1', 'docs/paths.ts:1', 'docs/paths.ts:2', 'docs/paths.ts:3', 'docs/paths.ts:4']);
});
