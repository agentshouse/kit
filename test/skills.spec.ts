import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import { conversationCredential, hostKit, lastInput, opened, type Hosted, type Hosting, type McpCall, type ToolResult } from './environment.ts';
import { temporaryHome } from './kit.ts';

const SKILL_SET = fileURLToPath(new URL('../skills/', import.meta.url));
const HOW_WE_WORK_TEXT = await readFile(new URL('../how-we-work.md', import.meta.url), 'utf8');
const { version: KIT_VERSION } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const LEFT_OUT = ['setup-matt-pocock-skills', 'triage', 'wizard'];
const PROVENANCE = /^<!-- Vendored from mattpocock\/skills at commit ([0-9a-f]{40}) \(/m;
const RECORD = 'skill-set.json';
const SERVER_WORKSPACE = '/agents/house';
const DOCUMENT = '/private/library/how-we-work.md';

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

async function names(): Promise<string[]> {
  return (await readdir(SKILL_SET)).sort();
}

async function upstreamAt(commit: string): Promise<string> {
  const root = await temporaryHome();
  const answer = await fetch(`https://codeload.github.com/mattpocock/skills/tar.gz/${commit}`);
  expect(answer.status).toBe(200);
  await writeFile(join(root, 'skills.tar.gz'), Buffer.from(await answer.arrayBuffer()));
  execFileSync('tar', ['-xzf', join(root, 'skills.tar.gz'), '-C', root]);
  return join(root, `skills-${commit}`);
}

function vendoredSkill(upstream: string, commit: string, path: string): string {
  const lines = upstream.split('\n');
  const end = lines.indexOf('---', 1);
  return [
    ...lines.slice(0, end).filter((line) => line !== 'disable-model-invocation: true'),
    '---',
    '',
    `<!-- Vendored from mattpocock/skills at commit ${commit} (${path}). MIT licensed — see LICENSE in this directory. -->`,
    ...lines.slice(end + 1),
  ].join('\n');
}

async function recorded(home: string): Promise<{ version?: string; names: string[] } | null> {
  return JSON.parse(await readFile(join(home, RECORD), 'utf8').catch(() => 'null')) as { version?: string; names: string[] } | null;
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function restart(hosted: Hosted, hosting: Hosting): Promise<Hosted> {
  process.kill(hosted.kit.pid, 'SIGKILL');
  await hosted.kit.exited;
  return hostKit([{}], { ...hosting, home: hosted.home });
}

function native(workspace: string, hosting: Hosting = {}): Hosting {
  return { ...hosting, environment: { HOUSE_KIT_WORKSPACE: workspace } };
}

function skills(root: string, name = ''): string {
  return join(root, '.agents', 'skills', name);
}

function claude(root: string, name = ''): string {
  return join(root, '.claude', 'skills', name);
}

function edits(hosted: Hosted): McpCall[] {
  return hosted.mcp.map((received) => received.body as McpCall).filter((call) => call.params.name === 'edit');
}

function configure(home: string, argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync(process.execPath, [fileURLToPath(new URL('../src/configure-main.ts', import.meta.url)), ...argv], {
    env: { ...process.env, HOUSE_KIT_HOME: home },
    encoding: 'utf8',
  });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

function refused(code: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: you may not write here\n` }] };
}

function conflicted(code: string): ToolResult {
  const conflicts = [{ path: DOCUMENT, code, ...(code === 'ancestor_conflict' ? { blocking: `${DOCUMENT}/notes.md` } : {}) }];
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `edit_conflict: nothing was written; fix each conflict listed, then send the edit again\n${stringify({ conflicts })}`,
      },
    ],
  };
}

it('vendors every skill the pinned upstream plugin manifest names but three, byte-identical but for the provenance header and the two invocation lines', async () => {
  const vendored = await names();
  const commits = new Set<string | undefined>();
  for (const name of vendored) {
    commits.add(PROVENANCE.exec(await readFile(join(SKILL_SET, name, 'SKILL.md'), 'utf8'))?.[1]);
  }
  expect(commits.size).toBe(1);
  const [commit] = commits as Set<string>;
  const upstream = await upstreamAt(commit);
  const manifest = JSON.parse(await readFile(join(upstream, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills: string[] };
  const declared = manifest.skills.map((path) => path.replace(/^\.\//, '')).filter((path) => !LEFT_OUT.includes(basename(path)));
  expect(declared).toHaveLength(manifest.skills.length - LEFT_OUT.length);

  expect(vendored).toEqual(declared.map((path) => basename(path)).sort());
  const license = await readFile(join(upstream, 'LICENSE'), 'utf8');
  for (const path of declared) {
    const name = basename(path);
    const source = join(upstream, path);
    const copy = join(SKILL_SET, name);
    expect(await tree(copy), name).toEqual([...(await tree(source)), 'LICENSE'].sort());
    for (const file of await tree(source)) {
      const original = await readFile(join(source, file), 'utf8');
      const expected =
        file === 'SKILL.md'
          ? vendoredSkill(original, commit, path)
          : file === join('agents', 'openai.yaml')
            ? original
                .split('\n')
                .filter((line) => line !== '  allow_implicit_invocation: false')
                .join('\n')
            : original;
      expect(await readFile(join(copy, file), 'utf8'), `${name}/${file}`).toBe(expected);
    }
    expect(await readFile(join(copy, 'LICENSE'), 'utf8'), `${name}/LICENSE`).toBe(license);
  }
});

it('installs every skill at the native workspace root with a relative Claude link resolving to it, and none in the user-level directories', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], native(workspace, { skills: true }));

  const vendored = await names();
  expect((await readdir(skills(workspace))).sort()).toEqual(vendored);
  expect((await readdir(claude(workspace))).sort()).toEqual(vendored);
  for (const name of vendored) {
    expect(await readlink(claude(workspace, name))).toBe(join('..', '..', '.agents', 'skills', name));
    expect(await realpath(claude(workspace, name))).toBe(await realpath(skills(workspace, name)));
    expect(await tree(skills(workspace, name))).toEqual(await tree(join(SKILL_SET, name)));
    for (const file of await tree(join(SKILL_SET, name))) {
      expect(await readFile(join(skills(workspace, name), file), 'utf8')).toBe(await readFile(join(SKILL_SET, name, file), 'utf8'));
    }
  }
  await absent(join(hosted.home, '.agents'));
  await absent(join(hosted.home, '.claude'));
  expect(await recorded(hosted.home)).toEqual({ version: KIT_VERSION, workspace, names: vendored });
});

it('installs every skill at /agents/house in the container and on a server', async () => {
  onTestFinished(async () => {
    for (const path of [skills(SERVER_WORKSPACE), claude(SERVER_WORKSPACE)]) await rm(path, { recursive: true, force: true });
  });
  const hosted = await hostKit([{}], { skills: true });

  const vendored = await names();
  expect((await readdir(skills(SERVER_WORKSPACE))).sort()).toEqual(vendored);
  for (const name of vendored) {
    expect(await readlink(claude(SERVER_WORKSPACE, name))).toBe(join('..', '..', '.agents', 'skills', name));
  }
  await absent(join(hosted.home, '.agents'));
  expect(await recorded(hosted.home)).toEqual({ version: KIT_VERSION, workspace: SERVER_WORKSPACE, names: vendored });
});

it('moves the skills an earlier Kit recorded in the user-level directories to the workspace root and leaves the unrecorded ones there', async () => {
  const home = await temporaryHome();
  const workspace = await temporaryHome();
  const vendored = await names();
  for (const name of vendored) {
    await mkdir(skills(home, name), { recursive: true });
    await writeFile(join(skills(home, name), 'SKILL.md'), 'an earlier release\n');
    await mkdir(claude(home), { recursive: true });
    await symlink(join('..', '..', '.agents', 'skills', name), claude(home, name));
  }
  await mkdir(skills(home, 'my-skill'));
  await mkdir(join(home, 'elsewhere'));
  await symlink(join(home, 'elsewhere'), claude(home, 'my-link'));
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-alpha.0', names: vendored }));

  await hostKit([{}], native(workspace, { home, skills: true }));

  expect(await readdir(skills(home))).toEqual(['my-skill']);
  expect(await readdir(claude(home))).toEqual(['my-link']);
  expect((await readdir(skills(workspace))).sort()).toEqual(vendored);
  expect(await readFile(join(skills(workspace, 'tdd'), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, 'tdd', 'SKILL.md'), 'utf8'));
  expect(await recorded(home)).toEqual({ version: KIT_VERSION, workspace, names: vendored });
});

it('links each skill so it resolves when the Claude skill directory is redirected elsewhere', async () => {
  const workspace = await temporaryHome();
  await mkdir(join(workspace, 'claude-skills'));
  await mkdir(join(workspace, '.claude'));
  await symlink(join(workspace, 'claude-skills'), claude(workspace));

  await hostKit([{}], native(workspace, { skills: true }));

  for (const name of await names()) {
    expect(await readlink(claude(workspace, name))).toBe(join('..', '.agents', 'skills', name));
    expect(await realpath(claude(workspace, name))).toBe(await realpath(skills(workspace, name)));
  }
});

it('makes no per-skill link when the Claude skill directory already resolves to the shared one', async () => {
  const workspace = await temporaryHome();
  await mkdir(skills(workspace), { recursive: true });
  await mkdir(join(workspace, '.claude'));
  await symlink(join('..', '.agents', 'skills'), claude(workspace));

  const hosted = await hostKit([{}], native(workspace, { skills: true }));

  expect(await readlink(claude(workspace))).toBe(join('..', '.agents', 'skills'));
  for (const name of await names()) {
    expect((await lstat(skills(workspace, name))).isDirectory()).toBe(true);
  }
  expect(await recorded(hosted.home)).toEqual({ version: KIT_VERSION, workspace, names: await names() });
});

it('leaves a skill directory or link the record does not name untouched and installs nothing under its name', async () => {
  const workspace = await temporaryHome();
  await mkdir(skills(workspace, 'tdd'), { recursive: true });
  await writeFile(join(skills(workspace, 'tdd'), 'SKILL.md'), "the owner's tdd\n");
  await mkdir(claude(workspace), { recursive: true });
  await mkdir(join(workspace, 'elsewhere'));
  await symlink(join(workspace, 'elsewhere'), claude(workspace, 'grilling'));

  const hosted = await hostKit([{}], native(workspace, { skills: true }));

  expect(await readFile(join(skills(workspace, 'tdd'), 'SKILL.md'), 'utf8')).toBe("the owner's tdd\n");
  await absent(claude(workspace, 'tdd'));
  expect(await readlink(claude(workspace, 'grilling'))).toBe(join(workspace, 'elsewhere'));
  await absent(skills(workspace, 'grilling'));
  expect(await recorded(hosted.home)).toEqual({
    version: KIT_VERSION,
    workspace,
    names: (await names()).filter((name) => name !== 'tdd' && name !== 'grilling'),
  });
});

it('keeps an installed skill as the owner edited it while the Kit version is the same', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], native(workspace, { skills: true }));
  await writeFile(join(skills(workspace, 'tdd'), 'SKILL.md'), "the owner's own tdd\n");

  await restart(hosted, native(workspace, { skills: true }));

  expect(await readFile(join(skills(workspace, 'tdd'), 'SKILL.md'), 'utf8')).toBe("the owner's own tdd\n");
});

it('replaces only the names an earlier Kit version recorded when a new version starts', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], native(workspace, { skills: true }));
  await writeFile(join(skills(workspace, 'tdd'), 'SKILL.md'), "the owner's own tdd\n");
  await writeFile(join(skills(workspace, 'tdd'), 'notes.md'), 'an added file\n');
  await rm(claude(workspace, 'grilling'));
  await mkdir(skills(workspace, 'retired'));
  await symlink(join('..', '..', '.agents', 'skills', 'retired'), claude(workspace, 'retired'));
  await mkdir(skills(workspace, 'my-tdd'));
  await writeFile(join(skills(workspace, 'my-tdd'), 'SKILL.md'), 'my copy\n');
  await writeFile(
    join(hosted.home, RECORD),
    JSON.stringify({ version: '0.2.1-alpha.0', workspace, names: [...(await names()), 'retired'] }),
  );

  await restart(hosted, native(workspace, { skills: true }));

  expect(await readFile(join(skills(workspace, 'tdd'), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, 'tdd', 'SKILL.md'), 'utf8'));
  await absent(join(skills(workspace, 'tdd'), 'notes.md'));
  expect(await readlink(claude(workspace, 'grilling'))).toBe(join('..', '..', '.agents', 'skills', 'grilling'));
  await absent(skills(workspace, 'retired'));
  await absent(claude(workspace, 'retired'));
  expect(await readFile(join(skills(workspace, 'my-tdd'), 'SKILL.md'), 'utf8')).toBe('my copy\n');
  expect(await recorded(hosted.home)).toEqual({ version: KIT_VERSION, workspace, names: await names() });
});

it('removes every recorded skill from the workspace root and the record and installs nothing when the Skill set is declined', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], native(workspace, { skills: true }));
  await mkdir(skills(workspace, 'my-skill'));
  await writeFile(claude(workspace, 'my-note'), "the owner's\n");

  await restart(hosted, native(workspace, { skills: false }));

  expect(await readdir(skills(workspace))).toEqual(['my-skill']);
  expect(await readdir(claude(workspace))).toEqual(['my-note']);
  expect(await recorded(hosted.home)).toBeNull();
});

it('keeps the bootstrap choice in Kit configuration, says when a run changed it, and the next start honors it', async () => {
  const home = await temporaryHome();
  const workspace = await temporaryHome();

  expect(configure(home, [])).toEqual({ status: 0, stdout: '', stderr: '' });
  let hosted = await hostKit([{}], native(workspace, { home }));
  expect((await readdir(skills(workspace))).sort()).toEqual(await names());

  expect(configure(home, ['--no-skills'])).toEqual({ status: 0, stdout: 'changed\n', stderr: '' });
  expect(configure(home, ['--no-skills'])).toEqual({ status: 0, stdout: '', stderr: '' });
  hosted = await restart(hosted, native(workspace));
  expect(await readdir(skills(workspace))).toEqual([]);

  expect(configure(home, [])).toEqual({ status: 0, stdout: 'changed\n', stderr: '' });
  await restart(hosted, native(workspace));
  expect((await readdir(skills(workspace))).sort()).toEqual(await names());
});

it('creates the How-we-work document over the first conversation bridge after the Skill set is installed, once', async () => {
  const hosted = await hostKit([{}], native(await temporaryHome(), { skills: true }));

  await opened(hosted, 'conversation-1');
  await opened(hosted, 'conversation-2');

  expect(edits(hosted)).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({
        arguments: { changes: [{ op: 'create', path: DOCUMENT, content: HOW_WE_WORK_TEXT }] },
        _meta: expect.objectContaining({ 'agents.house/agent-operation': expect.any(String) }),
      }),
    }),
  ]);
  expect(hosted.mcp.find((received) => (received.body as McpCall).params.name === 'edit')!.headers.authorization).toBe(
    `Bearer ${conversationCredential('conversation-1')}`,
  );
  expect(HOW_WE_WORK_TEXT.startsWith('# How we work\n')).toBe(true);
});

it.each(['operation_denied', 'room_not_found'])(
  'leaves the document to the next conversation when %s refuses the Profile ceiling',
  async (code) => {
    const hosted = await hostKit([{}], native(await temporaryHome(), { skills: true }));
    hosted.tools.edit = (_args, request) =>
      request.headers.authorization === `Bearer ${conversationCredential('conversation-1')}`
        ? refused(code)
        : { content: [{ type: 'text', text: 'results: []' }] };

    hosted.input({ kind: 'open', conversation_id: 'conversation-1' });

    expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
    await opened(hosted, 'conversation-2');
    await opened(hosted, 'conversation-3');
    expect(edits(hosted)).toHaveLength(2);
  },
);

it('keeps a present document as it is and never creates it again', async () => {
  const hosted = await hostKit([{}], native(await temporaryHome(), { skills: true }));
  hosted.tools.edit = () => conflicted('path_exists');

  await opened(hosted, 'conversation-1');
  await opened(hosted, 'conversation-2');

  expect(edits(hosted)).toHaveLength(1);
});

it("refuses to open a conversation with House's answer when another refusal stops the document, and tries again at the next", async () => {
  const hosted = await hostKit([{}], native(await temporaryHome(), { skills: true }));
  hosted.tools.edit = () => refused('invalid_library');

  hosted.input({ kind: 'open', conversation_id: 'conversation-1' });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('invalid_library') });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toEqual([]);
  hosted.tools.edit = () => ({ content: [{ type: 'text', text: 'results: []' }] });
  await opened(hosted, 'conversation-2');
  expect(edits(hosted)).toHaveLength(2);
});

it('refuses to open a conversation while another path blocks the absent document, and creates it once the path is free', async () => {
  const hosted = await hostKit([{}], native(await temporaryHome(), { skills: true }));
  hosted.tools.edit = () => conflicted('ancestor_conflict');

  hosted.input({ kind: 'open', conversation_id: 'conversation-1' });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('ancestor_conflict') });
  hosted.tools.edit = () => ({ content: [{ type: 'text', text: 'results: []' }] });
  await opened(hosted, 'conversation-2');
  await opened(hosted, 'conversation-3');
  expect(edits(hosted)).toHaveLength(2);
});

it('creates no document without an installed Skill set, nor again after a release, a decline or a later acceptance', async () => {
  const workspace = await temporaryHome();
  let hosted = await hostKit([{}], native(workspace, { skills: false }));
  await opened(hosted, 'conversation-1');
  expect(edits(hosted)).toEqual([]);

  hosted = await restart(hosted, native(workspace, { skills: true }));
  await opened(hosted, 'conversation-2');
  expect(edits(hosted)).toHaveLength(1);

  await writeFile(join(hosted.home, RECORD), JSON.stringify({ version: '0.2.1-alpha.0', workspace, names: await names() }));
  for (const [index, accepted] of [true, false, true].entries()) {
    hosted = await restart(hosted, native(workspace, { skills: accepted }));
    await opened(hosted, `conversation-${index + 3}`);
    expect(edits(hosted)).toEqual([]);
  }
  expect((await readdir(skills(workspace))).sort()).toEqual(await names());
});
