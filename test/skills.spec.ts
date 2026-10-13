import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import { startHouse } from './double.ts';
import { conversationCredential, hostKit, lastInput, opened, userBin, type Hosted, type Hosting, type McpCall, type ToolResult } from './environment.ts';
import { readOnlyHome, temporaryHome } from './kit.ts';
import { logIn, serveLogin } from './login.ts';

const SKILL_SET = fileURLToPath(new URL('../skills/', import.meta.url));
const HOW_WE_WORK_TEXT = await readFile(new URL('../how-we-work.md', import.meta.url), 'utf8');
const { version: KIT_VERSION } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const UPSTREAM = JSON.parse(await readFile(new URL('../skills-upstream.json', import.meta.url), 'utf8')) as {
  repository: string;
  commit: string;
  date: string;
};
const CATEGORIES = ['engineering', 'productivity'];
const LEFT_OUT = 'setup-matt-pocock-skills';
const [FIRST, SECOND] = (await readdir(SKILL_SET)).sort();
const RECORD = 'skill-set.json';
const DOCUMENT = '/rooms/private/how-we-work.md';

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

function skills(home: string, name = ''): string {
  return join(home, '.agents', 'skills', name);
}

function claude(home: string, name = ''): string {
  return join(home, '.claude', 'skills', name);
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

it('ships every engineering and productivity skill upstream has at the recorded commit but setup, verbatim, each with the upstream license', async () => {
  expect(UPSTREAM).toEqual({
    repository: 'https://github.com/mattpocock/skills',
    commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  });
  const upstream = await upstreamAt(UPSTREAM.commit);
  const sources = new Map<string, string>();
  for (const category of CATEGORIES) {
    for (const entry of await readdir(join(upstream, 'skills', category), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== LEFT_OUT) sources.set(entry.name, join(upstream, 'skills', category, entry.name));
    }
  }

  expect(await names()).toEqual([...sources.keys()].sort());
  const license = await readFile(join(upstream, 'LICENSE'), 'utf8');
  for (const [name, source] of sources) {
    const copy = join(SKILL_SET, name);
    const files = await tree(source);
    expect(await tree(copy), name).toEqual([...new Set([...files, 'LICENSE'])].sort());
    for (const file of files) {
      expect(await readFile(join(copy, file), 'utf8'), `${name}/${file}`).toBe(await readFile(join(source, file), 'utf8'));
    }
    if (!files.includes('LICENSE')) expect(await readFile(join(copy, 'LICENSE'), 'utf8'), `${name}/LICENSE`).toBe(license);
  }
});

it('installs every skill for the home it launches agent CLIs with, with a relative Claude link resolving to it', async () => {
  const hosted = await hostKit([{}], { skills: true });

  const vendored = await names();
  expect((await readdir(skills(hosted.home))).sort()).toEqual(vendored);
  expect((await readdir(claude(hosted.home))).sort()).toEqual(vendored);
  for (const name of vendored) {
    expect(await readlink(claude(hosted.home, name))).toBe(join('..', '..', '.agents', 'skills', name));
    expect(await realpath(claude(hosted.home, name))).toBe(await realpath(skills(hosted.home, name)));
    expect(await tree(skills(hosted.home, name))).toEqual(await tree(join(SKILL_SET, name)));
    for (const file of await tree(join(SKILL_SET, name))) {
      expect(await readFile(join(skills(hosted.home, name), file), 'utf8')).toBe(await readFile(join(SKILL_SET, name, file), 'utf8'));
    }
  }
  expect(await recorded(hosted.home)).toEqual({ version: KIT_VERSION, names: vendored });
});

it('links each skill so it resolves when the Claude skill directory is redirected elsewhere', async () => {
  const home = await temporaryHome();
  await mkdir(join(home, 'claude-skills'));
  await mkdir(join(home, '.claude'));
  await symlink(join(home, 'claude-skills'), claude(home));

  await hostKit([{}], { home, skills: true });

  for (const name of await names()) {
    expect(await readlink(claude(home, name))).toBe(join('..', '.agents', 'skills', name));
    expect(await realpath(claude(home, name))).toBe(await realpath(skills(home, name)));
  }
});

it('makes no per-skill link when the Claude skill directory already resolves to the shared one', async () => {
  const home = await temporaryHome();
  await mkdir(skills(home), { recursive: true });
  await mkdir(join(home, '.claude'));
  await symlink(join('..', '.agents', 'skills'), claude(home));

  await hostKit([{}], { home, skills: true });

  expect(await readlink(claude(home))).toBe(join('..', '.agents', 'skills'));
  for (const name of await names()) {
    expect((await lstat(skills(home, name))).isDirectory()).toBe(true);
  }
  expect(await recorded(home)).toEqual({ version: KIT_VERSION, names: await names() });
});

it('leaves a skill directory or link the record does not name untouched and installs nothing under its name', async () => {
  const home = await temporaryHome();
  await mkdir(skills(home, FIRST), { recursive: true });
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's skill\n");
  await mkdir(claude(home), { recursive: true });
  await mkdir(join(home, 'elsewhere'));
  await symlink(join(home, 'elsewhere'), claude(home, SECOND));

  await hostKit([{}], { home, skills: true });

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe("the owner's skill\n");
  await absent(claude(home, FIRST));
  expect(await readlink(claude(home, SECOND))).toBe(join(home, 'elsewhere'));
  await absent(skills(home, SECOND));
  expect(await recorded(home)).toEqual({
    version: KIT_VERSION,
    names: (await names()).filter((name) => name !== FIRST && name !== SECOND),
  });
});

it('keeps an installed skill as the owner edited it while the Kit version is the same', async () => {
  const hosted = await hostKit([{}], { skills: true });
  await writeFile(join(skills(hosted.home, FIRST), 'SKILL.md'), "the owner's own skill\n");

  await restart(hosted, { skills: true });

  expect(await readFile(join(skills(hosted.home, FIRST), 'SKILL.md'), 'utf8')).toBe("the owner's own skill\n");
});

it('replaces only the names an earlier Kit version recorded when a new version starts', async () => {
  const hosted = await hostKit([{}], { skills: true });
  const home = hosted.home;
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's own skill\n");
  await writeFile(join(skills(home, FIRST), 'notes.md'), 'an added file\n');
  await rm(claude(home, SECOND));
  await mkdir(skills(home, 'retired'));
  await symlink(join('..', '..', '.agents', 'skills', 'retired'), claude(home, 'retired'));
  await mkdir(skills(home, 'my-tdd'));
  await writeFile(join(skills(home, 'my-tdd'), 'SKILL.md'), 'my copy\n');
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-alpha.0', names: [...(await names()), 'retired'] }));

  await restart(hosted, { skills: true });

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, FIRST, 'SKILL.md'), 'utf8'));
  await absent(join(skills(home, FIRST), 'notes.md'));
  expect(await readlink(claude(home, SECOND))).toBe(join('..', '..', '.agents', 'skills', SECOND));
  await absent(skills(home, 'retired'));
  await absent(claude(home, 'retired'));
  expect(await readFile(join(skills(home, 'my-tdd'), 'SKILL.md'), 'utf8')).toBe('my copy\n');
  expect(await recorded(home)).toEqual({ version: KIT_VERSION, names: await names() });
});

it("brings an updated upstream set with a new Kit version: a skill upstream dropped leaves both directories and one it added arrives", async () => {
  const hosted = await hostKit([{}], { skills: true });
  const home = hosted.home;
  const current = await names();
  const added = current.at(-1)!;
  await rm(skills(home, added), { recursive: true });
  await rm(claude(home, added));
  await mkdir(skills(home, 'dropped-upstream'));
  await writeFile(join(skills(home, 'dropped-upstream'), 'SKILL.md'), 'an earlier upstream skill\n');
  await symlink(join('..', '..', '.agents', 'skills', 'dropped-upstream'), claude(home, 'dropped-upstream'));
  const earlier = [...current.filter((name) => name !== added), 'dropped-upstream'].sort();
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-c000000000000', names: earlier }));

  await restart(hosted, { skills: true });

  await absent(skills(home, 'dropped-upstream'));
  await absent(claude(home, 'dropped-upstream'));
  expect(await tree(skills(home, added))).toEqual(await tree(join(SKILL_SET, added)));
  expect(await realpath(claude(home, added))).toBe(await realpath(skills(home, added)));
  expect((await readdir(skills(home))).sort()).toEqual(current);
  expect(await recorded(home)).toEqual({ version: KIT_VERSION, names: current });
});

it('removes every recorded skill and the record and installs nothing when the Skill set is declined', async () => {
  const hosted = await hostKit([{}], { skills: true });
  await mkdir(skills(hosted.home, 'my-skill'));
  await writeFile(claude(hosted.home, 'my-note'), "the owner's\n");

  await restart(hosted, { skills: false });

  expect(await readdir(skills(hosted.home))).toEqual(['my-skill']);
  expect(await readdir(claude(hosted.home))).toEqual(['my-note']);
  expect(await recorded(hosted.home)).toBeNull();
});

it('keeps the bootstrap choice in Kit configuration, says when a run changed it, and the next start honors it', async () => {
  const home = await temporaryHome();

  expect(configure(home, [])).toEqual({ status: 0, stdout: '', stderr: '' });
  let hosted = await hostKit([{}], { home });
  expect((await readdir(skills(home))).sort()).toEqual(await names());

  expect(configure(home, ['--no-skills'])).toEqual({ status: 0, stdout: 'changed\n', stderr: '' });
  expect(configure(home, ['--no-skills'])).toEqual({ status: 0, stdout: '', stderr: '' });
  hosted = await restart(hosted, {});
  expect(await readdir(skills(home))).toEqual([]);

  expect(configure(home, [])).toEqual({ status: 0, stdout: 'changed\n', stderr: '' });
  await restart(hosted, {});
  expect((await readdir(skills(home))).sort()).toEqual(await names());
});

it('places every skill at kit login in the home of whoever runs it, with no resident, under the same record', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const { exit } = await logIn(house, join(home, '.house-kit'), { HOME: home });

  expect(exit).toBe(0);
  expect((await readdir(skills(home))).sort()).toEqual(await names());
  for (const name of await names()) {
    expect(await realpath(claude(home, name))).toBe(await realpath(skills(home, name)));
  }
  expect(await recorded(join(home, '.house-kit'))).toEqual({ version: KIT_VERSION, names: await names() });
});

it('places no skill at kit login when the Skill set is declined', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  expect(configure(join(home, '.house-kit'), ['--no-skills']).status).toBe(0);

  const { exit } = await logIn(house, join(home, '.house-kit'), { HOME: home });

  expect(exit).toBe(0);
  await absent(skills(home));
  await absent(claude(home));
  expect(await recorded(join(home, '.house-kit'))).toBeNull();
});

it('keeps the Environment connected from a read-only home, saying the skills could not be placed, and creates no How-we-work document', async () => {
  const home = await temporaryHome();
  const readOnly = await temporaryHome();
  await writeFile(join(readOnly, '.profile'), `PATH="${userBin(home)}:${join(home, 'bin')}:$PATH"\n`);
  await readOnlyHome(readOnly);

  const hosted = await hostKit([{}], { home, skills: true, environment: { HOME: readOnly, CODEX_HOME: await temporaryHome() } });
  hosted.input({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  expect(hosted.kit.stderr()).toMatch(/^kit: the skills could not be placed: EACCES: .*\.agents/m);
  expect(edits(hosted)).toEqual([]);
});

it('creates no How-we-work document for a declined Skill set whose recorded skills could not be removed', async () => {
  const hosted = await hostKit([{}], {
    skills: false,
    prepare: async (home) => {
      await mkdir(skills(home, 'grill-me'), { recursive: true });
      await writeFile(join(home, RECORD), JSON.stringify({ version: KIT_VERSION, names: ['grill-me'] }));
      await chmod(skills(home), 0o555);
      onTestFinished(() => chmod(skills(home), 0o700));
    },
  });
  await opened(hosted, 'conversation-1');

  expect(hosted.kit.stderr()).toMatch(/^kit: the skills could not be placed: EACCES: /m);
  expect(edits(hosted)).toEqual([]);
});

it('creates the How-we-work document over the first conversation bridge after the Skill set is installed, once', async () => {
  const hosted = await hostKit([{}], { skills: true });

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
  expect(HOW_WE_WORK_TEXT).toContain('- Glossary (`GLOSSARY.md`): `glossary.md`\n- Decisions (ADRs): `decisions/NNNN-<slug>.md`\n');
  expect(HOW_WE_WORK_TEXT).not.toContain('library/');
});

it.each(['operation_denied', 'room_not_found'])(
  'leaves the document to the next conversation when %s refuses the Profile ceiling',
  async (code) => {
    const hosted = await hostKit([{}], { skills: true });
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
  const hosted = await hostKit([{}], { skills: true });
  hosted.tools.edit = () => conflicted('path_exists');

  await opened(hosted, 'conversation-1');
  await opened(hosted, 'conversation-2');

  expect(edits(hosted)).toHaveLength(1);
});

it("refuses to open a conversation with House's answer when another refusal stops the document, and tries again at the next", async () => {
  const hosted = await hostKit([{}], { skills: true });
  hosted.tools.edit = () => refused('invalid_documents');

  hosted.input({ kind: 'open', conversation_id: 'conversation-1' });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('invalid_documents') });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toEqual([]);
  hosted.tools.edit = () => ({ content: [{ type: 'text', text: 'results: []' }] });
  await opened(hosted, 'conversation-2');
  expect(edits(hosted)).toHaveLength(2);
});

it('refuses to open a conversation while another path blocks the absent document, and creates it once the path is free', async () => {
  const hosted = await hostKit([{}], { skills: true });
  hosted.tools.edit = () => conflicted('ancestor_conflict');

  hosted.input({ kind: 'open', conversation_id: 'conversation-1' });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('ancestor_conflict') });
  hosted.tools.edit = () => ({ content: [{ type: 'text', text: 'results: []' }] });
  await opened(hosted, 'conversation-2');
  await opened(hosted, 'conversation-3');
  expect(edits(hosted)).toHaveLength(2);
});

it('creates no document without an installed Skill set, nor again after a release, a decline or a later acceptance', async () => {
  let hosted = await hostKit([{}], { skills: false });
  await opened(hosted, 'conversation-1');
  expect(edits(hosted)).toEqual([]);

  hosted = await restart(hosted, { skills: true });
  await opened(hosted, 'conversation-2');
  expect(edits(hosted)).toHaveLength(1);

  await writeFile(join(hosted.home, RECORD), JSON.stringify({ version: '0.2.1-alpha.0', names: await names() }));
  for (const [index, accepted] of [true, false, true].entries()) {
    hosted = await restart(hosted, { skills: accepted });
    await opened(hosted, `conversation-${index + 3}`);
    expect(edits(hosted)).toEqual([]);
  }
  expect((await readdir(skills(hosted.home))).sort()).toEqual(await names());
});
