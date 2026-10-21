import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills } from '@agentshouse/skills';
import { expect, it, onTestFinished } from 'vitest';
import { startHouse } from './double.ts';
import { hostKit, lastCall, opened, userBin, type Hosted, type Hosting } from './environment.ts';
import { readOnlyHome, temporaryHome } from './kit.ts';
import { logIn, serveLogin } from './login.ts';

const MANIFEST = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const KIT_RELEASE = MANIFEST.version;
const PACKAGE = '@agentshouse/skills';
const PACKAGE_ROOT = fileURLToPath(new URL(`../node_modules/${PACKAGE}/`, import.meta.url));
const SKILL_SET = join(PACKAGE_ROOT, 'set');
const NAMES = listSkills().map((skill) => skill.name);
const [FIRST, SECOND] = NAMES;
const RECORD = 'skill-set.json';

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
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

function configure(home: string, argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync(process.execPath, [fileURLToPath(new URL('../src/configure-main.ts', import.meta.url)), ...argv], {
    env: { ...process.env, HOUSE_KIT_HOME: home },
    encoding: 'utf8',
  });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

it("installs every Skill of the package at the version the Kit pins, file for file, for the home it launches agent CLIs with, with a relative Claude link resolving to each", async () => {
  const pinned = MANIFEST.dependencies[PACKAGE]!;
  expect(pinned).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  expect(JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))).toMatchObject({ name: PACKAGE, version: pinned });
  expect(NAMES).toEqual((await readdir(SKILL_SET)).sort());
  expect(NAMES.length).toBeGreaterThan(1);

  const hosted = await hostKit([{}], { skills: true });

  expect((await readdir(skills(hosted.home))).sort()).toEqual(NAMES);
  expect((await readdir(claude(hosted.home))).sort()).toEqual(NAMES);
  for (const name of NAMES) {
    expect(await readlink(claude(hosted.home, name))).toBe(join('..', '..', '.agents', 'skills', name));
    expect(await realpath(claude(hosted.home, name))).toBe(await realpath(skills(hosted.home, name)));
    expect(await tree(skills(hosted.home, name)), name).toEqual(await tree(join(SKILL_SET, name)));
    for (const file of await tree(join(SKILL_SET, name))) {
      expect(await readFile(join(skills(hosted.home, name), file), 'utf8'), `${name}/${file}`).toBe(await readFile(join(SKILL_SET, name, file), 'utf8'));
    }
  }
  expect(await recorded(hosted.home)).toEqual({ version: KIT_RELEASE, names: NAMES });
});

it('links each skill so it resolves when the Claude skill directory is redirected elsewhere', async () => {
  const home = await temporaryHome();
  await mkdir(join(home, 'claude-skills'));
  await mkdir(join(home, '.claude'));
  await symlink(join(home, 'claude-skills'), claude(home));

  await hostKit([{}], { home, skills: true });

  for (const name of NAMES) {
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
  for (const name of NAMES) {
    expect((await lstat(skills(home, name))).isDirectory()).toBe(true);
  }
  expect(await recorded(home)).toEqual({ version: KIT_RELEASE, names: NAMES });
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
    version: KIT_RELEASE,
    names: NAMES.filter((name) => name !== FIRST && name !== SECOND),
  });
});

it('keeps an installed skill as the owner edited it while the Kit release is the same', async () => {
  const hosted = await hostKit([{}], { skills: true });
  await writeFile(join(skills(hosted.home, FIRST), 'SKILL.md'), "the owner's own skill\n");

  await restart(hosted, { skills: true });

  expect(await readFile(join(skills(hosted.home, FIRST), 'SKILL.md'), 'utf8')).toBe("the owner's own skill\n");
});

it('replaces only the names an earlier Kit release recorded when a new version starts', async () => {
  const hosted = await hostKit([{}], { skills: true });
  const home = hosted.home;
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's own skill\n");
  await writeFile(join(skills(home, FIRST), 'notes.md'), 'an added file\n');
  await rm(claude(home, SECOND));
  await mkdir(skills(home, 'retired'));
  await symlink(join('..', '..', '.agents', 'skills', 'retired'), claude(home, 'retired'));
  await mkdir(skills(home, 'my-tdd'));
  await writeFile(join(skills(home, 'my-tdd'), 'SKILL.md'), 'my copy\n');
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-alpha.0', names: [...NAMES, 'retired'] }));

  await restart(hosted, { skills: true });

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, FIRST, 'SKILL.md'), 'utf8'));
  await absent(join(skills(home, FIRST), 'notes.md'));
  expect(await readlink(claude(home, SECOND))).toBe(join('..', '..', '.agents', 'skills', SECOND));
  await absent(skills(home, 'retired'));
  await absent(claude(home, 'retired'));
  expect(await readFile(join(skills(home, 'my-tdd'), 'SKILL.md'), 'utf8')).toBe('my copy\n');
  expect(await recorded(home)).toEqual({ version: KIT_RELEASE, names: NAMES });
});

it("brings the package's set with a new Kit release: a Skill the package dropped leaves both directories and one it added arrives", async () => {
  const hosted = await hostKit([{}], { skills: true });
  const home = hosted.home;
  const added = NAMES.at(-1)!;
  await rm(skills(home, added), { recursive: true });
  await rm(claude(home, added));
  await mkdir(skills(home, 'dropped-upstream'));
  await writeFile(join(skills(home, 'dropped-upstream'), 'SKILL.md'), 'an earlier upstream skill\n');
  await symlink(join('..', '..', '.agents', 'skills', 'dropped-upstream'), claude(home, 'dropped-upstream'));
  const earlier = [...NAMES.filter((name) => name !== added), 'dropped-upstream'].sort();
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-c000000000000', names: earlier }));

  await restart(hosted, { skills: true });

  await absent(skills(home, 'dropped-upstream'));
  await absent(claude(home, 'dropped-upstream'));
  expect(await tree(skills(home, added))).toEqual(await tree(join(SKILL_SET, added)));
  expect(await realpath(claude(home, added))).toBe(await realpath(skills(home, added)));
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);
  expect(await recorded(home)).toEqual({ version: KIT_RELEASE, names: NAMES });
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
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);

  expect(configure(home, ['--no-skills'])).toEqual({ status: 0, stdout: 'changed\n', stderr: '' });
  expect(configure(home, ['--no-skills'])).toEqual({ status: 0, stdout: '', stderr: '' });
  hosted = await restart(hosted, {});
  expect(await readdir(skills(home))).toEqual([]);

  expect(configure(home, [])).toEqual({ status: 0, stdout: 'changed\n', stderr: '' });
  await restart(hosted, {});
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);
});

it('places every skill at kit login in the home of whoever runs it, with no resident, under the same record', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const { exit } = await logIn(house, join(home, '.house-kit'), { HOME: home });

  expect(exit).toBe(0);
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);
  for (const name of NAMES) {
    expect(await realpath(claude(home, name))).toBe(await realpath(skills(home, name)));
  }
  expect(await recorded(join(home, '.house-kit'))).toEqual({ version: KIT_RELEASE, names: NAMES });
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

it('keeps the Environment connected from a read-only home, saying the skills could not be placed', async () => {
  const home = await temporaryHome();
  const readOnly = await temporaryHome();
  await writeFile(join(readOnly, '.profile'), `PATH="${userBin(home)}:${join(home, 'bin')}:$PATH"\n`);
  await readOnlyHome(readOnly);

  const hosted = await hostKit([{}], { home, skills: true, environment: { HOME: readOnly, CODEX_HOME: await temporaryHome() } });
  hosted.call({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1' });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  expect(hosted.kit.stderr()).toMatch(/^kit: the skills could not be placed: EACCES: .*\.agents/m);
});

it('opens a conversation when a declined Skill set leaves recorded skills it could not remove', async () => {
  const hosted = await hostKit([{}], {
    skills: false,
    prepare: async (home) => {
      await mkdir(skills(home, FIRST), { recursive: true });
      await writeFile(join(home, RECORD), JSON.stringify({ version: KIT_RELEASE, names: [FIRST] }));
      await chmod(skills(home), 0o555);
      onTestFinished(() => chmod(skills(home), 0o700));
    },
  });
  await opened(hosted, 'conversation-1');

  expect(hosted.kit.stderr()).toMatch(/^kit: the skills could not be placed: EACCES: /m);
});
