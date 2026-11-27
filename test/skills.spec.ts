import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills } from '@agentshouse/skills';
import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished } from 'vitest';
import { catalogue, serveCatalogue, type OwnSkills } from './catalogue.ts';
import { settle, startHouse, until, type House } from './double.ts';
import { hostKit, opened, type Hosted, type Hosting } from './environment.ts';
import { accountOf, runKit, temporaryHome } from './kit.ts';
import { logIn, serveLogin } from './login.ts';
import { startStore } from './store.ts';

const MANIFEST = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const KIT_RELEASE = MANIFEST.version;
const PACKAGE = '@agentshouse/skills';
const PACKAGE_ROOT = fileURLToPath(new URL(`../node_modules/${PACKAGE}/`, import.meta.url));
const SKILL_SET = join(PACKAGE_ROOT, 'set');
const UPSTREAM = listSkills().map((skill) => skill.name);
const [FIRST, SECOND] = UPSTREAM;
const SKILL_PAGE = 'house-errand';
const NAMES = [...UPSTREAM, SKILL_PAGE].sort();
const RECORD = 'skill-set.json';
const PRIVATE_ROOM = 'r_private';

interface Recorded {
  version?: string;
  origin?: string;
  digest?: string;
  names: string[];
}

let own: OwnSkills = {};

function skillPage(origin: string): string {
  return `---\nname: ${SKILL_PAGE}\ndescription: Runs a House errand.\n---\n# House errand\n\nRuns a House errand.\n\nStart at ${origin}/app/new.git and send the User ${origin}/sign-up.\n`;
}

const PAGES: Record<string, string> = {
  'skills/errand.md': skillPage('<origin>'),
  'agent-functions/weekly.md': '---\ndescription: Sums up the week.\ninput: ""\n---\n# Weekly\n\nSums up the week.\n',
};

let plantedRoot: string;
let planted: Record<string, string>;

beforeAll(async () => {
  plantedRoot = await mkdtemp(join(tmpdir(), 'kit-skills-'));
  const copy = join(plantedRoot, 'skills');
  await cp(PACKAGE_ROOT, copy, { recursive: true });
  await rm(join(copy, 'guide', 'skills'), { recursive: true, force: true });
  for (const [path, text] of Object.entries(PAGES)) {
    await mkdir(dirname(join(copy, 'guide', path)), { recursive: true });
    await writeFile(join(copy, 'guide', path), text);
  }
  planted = { KIT_SKILLS_PACKAGE: copy, NODE_OPTIONS: `--import=${fileURLToPath(new URL('./planted-skills.ts', import.meta.url))}` };
});

afterAll(() => rm(plantedRoot, { recursive: true, force: true }));

beforeEach(() => {
  own = {};
});

function host(hosting: Hosting = {}, names: readonly string[] = NAMES): Promise<Hosted> {
  return hostKit([{}], {
    skills: 'all',
    ...hosting,
    tools: { guide: catalogue(names, () => own), ...hosting.tools },
    environment: { ...planted, ...hosting.environment },
  });
}

function served(house: House): void {
  serveCatalogue(house, NAMES, () => own);
}

function guideCalls(hosted: Hosted): Record<string, unknown>[] {
  return hosted.mcp
    .map((request) => (request.body as { params: { name?: string; arguments?: Record<string, unknown> } }).params)
    .filter(({ name }) => name === 'guide')
    .map(({ arguments: args }) => args ?? {});
}

function catalogueReads(hosted: Hosted): number {
  return guideCalls(hosted).filter((args) => args.names === undefined && args.cursor === undefined).length;
}

async function placed(home: string, digest?: string): Promise<Recorded> {
  return until(async () => {
    const record = await recorded(home);
    return record?.digest !== undefined && record.digest !== digest ? record : undefined;
  });
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

async function recorded(home: string): Promise<Recorded | null> {
  return JSON.parse(await readFile(join(home, RECORD), 'utf8').catch(() => 'null')) as Recorded | null;
}

function record(origin: string, names: readonly string[]): Recorded {
  return { version: KIT_RELEASE, origin, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string, names: [...names] };
}

async function kitSettings(hosted: Hosted, ...operands: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const kit = runKit(['settings', ...operands], { HOME: accountOf(hosted.home), ...planted });
  const status = await kit.exited;
  return { status, stdout: kit.stdout(), stderr: kit.stderr() };
}

async function knowingPrivateRoom(hosted: Hosted): Promise<void> {
  hosted.house.route('POST', '/kit/local-copies/selection/read', () => ({
    body: { local_copy: { rooms: [{ room_ref: PRIVATE_ROOM, room_handle: 'private', level: 'search' }] } },
  }));
  const opened = hosted.house.connections.length;
  hosted.connection.close(1012, 'deploy');
  await until(() => hosted.house.connections.length > opened && hosted.house.requests.filter((request) => request.path === '/kit/local-copies/selection/read').length > 1);
}

function notice(hosted: Hosted, room = PRIVATE_ROOM): void {
  hosted.house.connections.at(-1)!.send({ type: 'work_available', subject: 'rooms', room_ref: room });
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function restart(hosted: Hosted, hosting: Hosting = {}): Promise<Hosted> {
  process.kill(hosted.kit.pid, 'SIGKILL');
  await hosted.kit.exited;
  return host({ ...hosting, home: hosted.home });
}

function skills(home: string, name = ''): string {
  return join(accountOf(home), '.agents', 'skills', name);
}

function claude(home: string, name = ''): string {
  return join(accountOf(home), '.claude', 'skills', name);
}


const OWN = 'weekly-review';
const OWN_FILES = {
  'SKILL.md': `---\nname: ${OWN}\ndescription: Reviews the week.\n---\n# Weekly review\n\nReviews the week.\n`,
  'steps/first.md': 'Read the week.\n',
};

function callSettings(hosted: Hosted, change: Record<string, unknown>): string {
  const input_id = `settings-${randomUUID()}`;
  hosted.call({ input_id, conversation_id: null, agent_id: null, provider_session_id: null, kind: 'settings', ...change });
  return input_id;
}

it("installs every Skill of the package at the version the Kit pins, file for file, for the home it launches agent CLIs with, with a relative Claude link resolving to each", async () => {
  const pinned = MANIFEST.dependencies[PACKAGE]!;
  expect(pinned).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  expect(JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))).toMatchObject({ name: PACKAGE, version: pinned });
  expect(UPSTREAM).toEqual((await readdir(SKILL_SET)).sort());
  expect(UPSTREAM.length).toBeGreaterThan(1);

  const hosted = await host();
  await placed(hosted.home);

  expect((await readdir(skills(hosted.home))).sort()).toEqual(NAMES);
  expect((await readdir(claude(hosted.home))).sort()).toEqual(NAMES);
  for (const name of NAMES) {
    expect(await readlink(claude(hosted.home, name))).toBe(join('..', '..', '.agents', 'skills', name));
    expect(await realpath(claude(hosted.home, name))).toBe(await realpath(skills(hosted.home, name)));
  }
  for (const name of UPSTREAM) {
    expect(await tree(skills(hosted.home, name)), name).toEqual(await tree(join(SKILL_SET, name)));
    for (const file of await tree(join(SKILL_SET, name))) {
      expect(await readFile(join(skills(hosted.home, name), file), 'utf8'), `${name}/${file}`).toBe(await readFile(join(SKILL_SET, name, file), 'utf8'));
    }
  }
  expect(await recorded(hosted.home)).toEqual(record(hosted.house.origin, NAMES));
});

it("installs every Guide page the package labels a Skill as that Skill under its name, its SKILL.md the page with the Building's control origin filled in, and no other page", async () => {
  const hosted = await host();
  await placed(hosted.home);

  expect(await tree(skills(hosted.home, SKILL_PAGE))).toEqual(['SKILL.md']);
  expect(await readFile(join(skills(hosted.home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe(skillPage(hosted.house.origin));
  expect(await realpath(claude(hosted.home, SKILL_PAGE))).toBe(await realpath(skills(hosted.home, SKILL_PAGE)));
  await absent(skills(hosted.home, 'errand'));
  await absent(skills(hosted.home, 'weekly'));
  expect((await recorded(hosted.home))!.names).toContain(SKILL_PAGE);
});

it("installs for all exactly the names House's catalogue answers, page by page: a User's own by name, one ask each, one of a built-in's name in that built-in's place, and no Skill of the package the catalogue leaves out", async () => {
  own = { [OWN]: OWN_FILES, [FIRST]: { 'SKILL.md': 'my own first\n' } };

  const hosted = await host({}, NAMES.filter((name) => name !== SECOND));
  await placed(hosted.home);

  const names = [...NAMES.filter((name) => name !== SECOND), OWN].sort();
  expect((await readdir(skills(hosted.home))).sort()).toEqual(names);
  expect((await readdir(claude(hosted.home))).sort()).toEqual(names);
  expect(await tree(skills(hosted.home, OWN))).toEqual(['SKILL.md', join('steps', 'first.md')]);
  for (const [path, text] of Object.entries(OWN_FILES)) expect(await readFile(join(skills(hosted.home, OWN), path), 'utf8')).toBe(text);
  expect(await tree(skills(hosted.home, FIRST))).toEqual(['SKILL.md']);
  expect(await readFile(join(skills(hosted.home, FIRST), 'SKILL.md'), 'utf8')).toBe('my own first\n');
  await absent(skills(hosted.home, SECOND));
  expect(await recorded(hosted.home)).toEqual(record(hosted.house.origin, names));
  const pages = Array.from({ length: Math.ceil(names.length / 4) }, (_, page) => ({ op: 'skill', ...(page === 0 ? {} : { cursor: String(page * 4) }), long: true }));
  expect(pages.length).toBeGreaterThan(1);
  expect(guideCalls(hosted)).toEqual([...pages, ...[FIRST, OWN].sort().map((name) => ({ op: 'skill', names: [name], long: true }))]);
});

it("installs a User's own skill whole when House cuts its files across the pages of its answer, beside another one cut too", async () => {
  const long = (line: string) => Array.from({ length: 120 }, (_, index) => `${line} ${index}.\n`).join('');
  const cut: Record<string, Record<string, string>> = {
    [OWN]: { 'SKILL.md': `${OWN_FILES['SKILL.md']}${long('Read the week')}`, 'steps/first.md': long('First') },
    'long-errand': { 'SKILL.md': `---\nname: long-errand\ndescription: Runs a long errand.\n---\n${long('Run the errand')}` },
  };
  own = cut;

  const hosted = await host();
  await placed(hosted.home);

  for (const [name, files] of Object.entries(cut)) {
    expect(await tree(skills(hosted.home, name))).toEqual(Object.keys(files).sort());
    for (const [path, text] of Object.entries(files)) {
      expect(text.length, `${name}/${path}`).toBeGreaterThan(1_000);
      expect(await readFile(join(skills(hosted.home, name), path), 'utf8'), `${name}/${path}`).toBe(text);
    }
  }
  expect(guideCalls(hosted).filter((args) => args.names !== undefined && args.cursor !== undefined).length).toBeGreaterThan(2);
  expect(await recorded(hosted.home)).toEqual(record(hosted.house.origin, [...NAMES, OWN, 'long-errand'].sort()));
});

it("installs a User's own skill's attachment House answers by its download link byte for byte, and replaces it only once its bytes change, never for a new link alone", async () => {
  const store = await startStore();
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
  const redrawn = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  store.objects.set('attachments/icon', icon);
  store.objects.set('attachments/icon-redrawn', redrawn);
  own = { [OWN]: { ...OWN_FILES, 'assets/icon.png': { download: () => store.address('GET', 'attachments/icon') } } };
  const hosted = await host();
  const home = hosted.home;
  await knowingPrivateRoom(hosted);
  const first = await placed(home);
  await until(() => catalogueReads(hosted) >= 2);
  await settle();

  expect(await tree(skills(home, OWN))).toEqual(['SKILL.md', 'assets/icon.png', 'steps/first.md']);
  expect(await readFile(join(skills(home, OWN), 'assets/icon.png'))).toEqual(icon);

  await writeFile(join(skills(home, OWN), 'steps/first.md'), 'edited\n');
  const reads = catalogueReads(hosted);
  notice(hosted);
  await until(() => catalogueReads(hosted) > reads);
  await settle();

  expect(await readFile(join(skills(home, OWN), 'steps/first.md'), 'utf8')).toBe('edited\n');
  expect(await recorded(home)).toEqual(first);

  own = { [OWN]: { ...OWN_FILES, 'assets/icon.png': { download: () => store.address('GET', 'attachments/icon-redrawn') } } };
  notice(hosted);
  await placed(home, first.digest);

  expect(await readFile(join(skills(home, OWN), 'assets/icon.png'))).toEqual(redrawn);
  expect(await readFile(join(skills(home, OWN), 'steps/first.md'), 'utf8')).toBe(OWN_FILES['steps/first.md']);
  expect(await recorded(home)).toEqual(record(hosted.house.origin, [...NAMES, OWN].sort()));
});

it("installs for a list only its names, House's from the package and a User's own by name, and none the catalogue does not hold", async () => {
  own = { [OWN]: OWN_FILES };

  const hosted = await host({ skills: [SECOND, OWN, 'nowhere', SKILL_PAGE] });
  await placed(hosted.home);

  const names = [SECOND, OWN, SKILL_PAGE].sort();
  expect((await readdir(skills(hosted.home))).sort()).toEqual(names);
  expect(await tree(skills(hosted.home, SECOND))).toEqual(await tree(join(SKILL_SET, SECOND)));
  expect(await readFile(join(skills(hosted.home, OWN), 'SKILL.md'), 'utf8')).toBe(OWN_FILES['SKILL.md']);
  expect(await readFile(join(skills(hosted.home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe(skillPage(hosted.house.origin));
  expect(await recorded(hosted.home)).toEqual(record(hosted.house.origin, names));
});

it('links each skill so it resolves when the Claude skill directory is redirected elsewhere', async () => {
  const home = await temporaryHome();
  await mkdir(join(accountOf(home), 'claude-skills'));
  await mkdir(join(accountOf(home), '.claude'));
  await symlink(join(accountOf(home), 'claude-skills'), claude(home));

  await host({ home });
  await placed(home);

  for (const name of NAMES) {
    expect(await readlink(claude(home, name))).toBe(join('..', '.agents', 'skills', name));
    expect(await realpath(claude(home, name))).toBe(await realpath(skills(home, name)));
  }
});

it('makes no per-skill link when the Claude skill directory already resolves to the shared one', async () => {
  const home = await temporaryHome();
  await mkdir(skills(home), { recursive: true });
  await mkdir(join(accountOf(home), '.claude'));
  await symlink(join('..', '.agents', 'skills'), claude(home));

  const hosted = await host({ home });
  await placed(home);

  expect(await readlink(claude(home))).toBe(join('..', '.agents', 'skills'));
  for (const name of NAMES) {
    expect((await lstat(skills(home, name))).isDirectory()).toBe(true);
  }
  expect(await recorded(home)).toEqual(record(hosted.house.origin, NAMES));
});

it("leaves a skill directory or link the record does not name untouched and installs nothing under its name, a Skill page's and a User's own skill's names among them", async () => {
  own = { [OWN]: OWN_FILES };
  const home = await temporaryHome();
  await mkdir(skills(home, FIRST), { recursive: true });
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's skill\n");
  await mkdir(claude(home), { recursive: true });
  await mkdir(join(home, 'elsewhere'));
  await symlink(join(home, 'elsewhere'), claude(home, SECOND));
  await mkdir(skills(home, SKILL_PAGE), { recursive: true });
  await writeFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), "the owner's errand\n");
  await mkdir(skills(home, OWN), { recursive: true });
  await writeFile(join(skills(home, OWN), 'SKILL.md'), "the owner's review\n");

  const hosted = await host({ home });
  await placed(home);

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe("the owner's skill\n");
  await absent(claude(home, FIRST));
  expect(await readlink(claude(home, SECOND))).toBe(join(home, 'elsewhere'));
  await absent(skills(home, SECOND));
  expect(await readFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe("the owner's errand\n");
  await absent(claude(home, SKILL_PAGE));
  expect(await tree(skills(home, OWN))).toEqual(['SKILL.md']);
  expect(await readFile(join(skills(home, OWN), 'SKILL.md'), 'utf8')).toBe("the owner's review\n");
  await absent(claude(home, OWN));
  expect(await recorded(home)).toEqual(record(hosted.house.origin, NAMES.filter((name) => name !== FIRST && name !== SECOND && name !== SKILL_PAGE)));
});

it("replaces what it installed when the setting changes, by house settings and by House's settings call, never touching the owner's folder of a listed name", async () => {
  own = { [OWN]: OWN_FILES };
  const hosted = await host({ skills: [FIRST, SECOND] });
  const home = hosted.home;
  await placed(home);
  await writeFile(join(skills(home, SECOND), 'SKILL.md'), 'edited\n');
  await mkdir(skills(home, OWN));
  await writeFile(join(skills(home, OWN), 'SKILL.md'), "the owner's review\n");

  expect(await kitSettings(hosted, 'skills', SECOND, OWN)).toEqual({ status: 0, stdout: `skills ${SECOND} ${OWN}\nworkspace ${hosted.workspace}\n`, stderr: '' });

  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toMatchObject({ skills: [SECOND, OWN] });
  expect((await readdir(skills(home))).sort()).toEqual([SECOND, OWN].sort());
  expect((await readdir(claude(home))).sort()).toEqual([SECOND]);
  expect(await readFile(join(skills(home, SECOND), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, SECOND, 'SKILL.md'), 'utf8'));
  expect(await readFile(join(skills(home, OWN), 'SKILL.md'), 'utf8')).toBe("the owner's review\n");
  expect(await recorded(home)).toEqual(record(hosted.house.origin, [SECOND]));

  const call = callSettings(hosted, { skills: 'all' });

  expect(await hosted.result(call)).toEqual({ settings: { skills: 'all', workspace: hosted.workspace } });
  expect((await readdir(skills(home))).sort()).toEqual([...NAMES, OWN].sort());
  expect(await readFile(join(skills(home, OWN), 'SKILL.md'), 'utf8')).toBe("the owner's review\n");
  expect(await recorded(home)).toEqual(record(hosted.house.origin, NAMES));
  expect(await until(() => hosted.reports.findLast((report) => (report.settings as { skills?: unknown } | undefined)?.skills === 'all'))).toMatchObject({
    settings: { skills: 'all', workspace: hosted.workspace },
  });
});

it("replaces what it installed at the Private Room's notice when a User's own skill changed or went, and asks nothing at another Room's", async () => {
  own = { [OWN]: OWN_FILES, 'old-habit': { 'SKILL.md': 'an old habit\n' } };
  const hosted = await host();
  const home = hosted.home;
  await knowingPrivateRoom(hosted);
  const first = await placed(home);
  await until(() => catalogueReads(hosted) >= 2);
  await settle();
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), 'edited\n');
  const reads = catalogueReads(hosted);

  notice(hosted, 'r_notes');
  await settle();

  expect(catalogueReads(hosted)).toBe(reads);

  notice(hosted);
  await until(() => catalogueReads(hosted) > reads);
  await settle();

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe('edited\n');
  expect(await recorded(home)).toEqual(first);

  own = { [OWN]: { 'SKILL.md': 'reviews the week again\n' } };
  notice(hosted);
  await placed(home, first.digest);

  expect(await tree(skills(home, OWN))).toEqual(['SKILL.md']);
  expect(await readFile(join(skills(home, OWN), 'SKILL.md'), 'utf8')).toBe('reviews the week again\n');
  await absent(skills(home, 'old-habit'));
  await absent(claude(home, 'old-habit'));
  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, FIRST, 'SKILL.md'), 'utf8'));
  expect(await recorded(home)).toEqual(record(hosted.house.origin, [...NAMES, OWN].sort()));
});

it('keeps what it installed and says so when House refuses the catalogue', async () => {
  const hosted = await host();
  await placed(hosted.home);
  const before = await recorded(hosted.home);
  hosted.tools.guide = () => ({ isError: true, content: [{ type: 'text', text: 'house_unavailable: House cannot answer now' }] });

  expect(await kitSettings(hosted, 'skills', FIRST)).toMatchObject({ status: 0, stdout: `skills ${FIRST}\nworkspace ${hosted.workspace}\n` });

  expect(hosted.kit.stderr()).toMatch(/^kit: the skills could not be placed: house_unavailable: House cannot answer now$/m);
  expect((await readdir(skills(hosted.home))).sort()).toEqual(NAMES);
  expect(await recorded(hosted.home)).toEqual(before);
});

it('keeps an installed skill as the owner edited it while the Kit release and the Building are the same', async () => {
  const house = await startHouse();
  served(house);
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await logIn(house, home, planted);
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's own skill\n");
  await writeFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), "the owner's own errand\n");
  serveLogin(house, 'environment-one', 'ahk_second');

  await logIn(house, home, planted);

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe("the owner's own skill\n");
  expect(await readFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe("the owner's own errand\n");
});

it("fills the Skill pages in again with the other Building's control origin when the Kit logs in to another Building on the same Kit release", async () => {
  const first = await startHouse();
  const second = await startHouse();
  served(first);
  served(second);
  const home = await temporaryHome();
  serveLogin(first, 'environment-one', 'ahk_first');
  await logIn(first, home, planted);
  serveLogin(second, 'environment-two', 'ahk_second');

  const { exit } = await logIn(second, home, planted);

  expect(exit).toBe(0);
  expect(await readFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe(skillPage(second.origin));
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);
  expect(await recorded(home)).toEqual(record(second.origin, NAMES));
});

it('replaces only the names an earlier Kit release recorded when a new version starts, a User\'s own among them', async () => {
  own = { [OWN]: OWN_FILES };
  const hosted = await host();
  const home = hosted.home;
  await placed(home);
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's own skill\n");
  await writeFile(join(skills(home, FIRST), 'notes.md'), 'an added file\n');
  await writeFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), "the owner's own errand\n");
  await writeFile(join(skills(home, OWN), 'SKILL.md'), 'edited\n');
  await rm(claude(home, SECOND));
  await mkdir(skills(home, 'retired'));
  await symlink(join('..', '..', '.agents', 'skills', 'retired'), claude(home, 'retired'));
  await mkdir(skills(home, 'my-tdd'));
  await writeFile(join(skills(home, 'my-tdd'), 'SKILL.md'), 'my copy\n');
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-alpha.0', names: [...NAMES, OWN, 'retired'] }));

  const restarted = await restart(hosted);
  await placed(home);

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, FIRST, 'SKILL.md'), 'utf8'));
  await absent(join(skills(home, FIRST), 'notes.md'));
  expect(await readFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe(skillPage(restarted.house.origin));
  expect(await readFile(join(skills(home, OWN), 'SKILL.md'), 'utf8')).toBe(OWN_FILES['SKILL.md']);
  expect(await readlink(claude(home, SECOND))).toBe(join('..', '..', '.agents', 'skills', SECOND));
  await absent(skills(home, 'retired'));
  await absent(claude(home, 'retired'));
  expect(await readFile(join(skills(home, 'my-tdd'), 'SKILL.md'), 'utf8')).toBe('my copy\n');
  expect(await recorded(home)).toEqual(record(restarted.house.origin, [...NAMES, OWN].sort()));
});

it("replaces what an earlier Kit release installed even when House's catalogue and the User's own skills did not change", async () => {
  own = { [OWN]: OWN_FILES };
  const house = await startHouse();
  served(house);
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await logIn(house, home, planted);
  const first = (await recorded(home))!;
  await writeFile(join(skills(home, FIRST), 'SKILL.md'), "the owner's edit\n");
  await writeFile(join(skills(home, OWN), 'SKILL.md'), 'edited\n');
  await writeFile(join(home, RECORD), JSON.stringify({ ...first, version: '0.2.1-c000000000000' }));
  serveLogin(house, 'environment-one', 'ahk_second');

  await logIn(house, home, planted);

  expect(await readFile(join(skills(home, FIRST), 'SKILL.md'), 'utf8')).toBe(await readFile(join(SKILL_SET, FIRST, 'SKILL.md'), 'utf8'));
  expect(await readFile(join(skills(home, OWN), 'SKILL.md'), 'utf8')).toBe(OWN_FILES['SKILL.md']);
  expect(await recorded(home)).toEqual(first);
});

it("brings the package's set with a new Kit release: a Skill the package dropped leaves both directories and one it added arrives, a Skill page among them", async () => {
  const hosted = await host();
  const home = hosted.home;
  await placed(home);
  const added = UPSTREAM.at(-1)!;
  await rm(skills(home, added), { recursive: true });
  await rm(claude(home, added));
  await rm(skills(home, SKILL_PAGE), { recursive: true });
  await rm(claude(home, SKILL_PAGE));
  await mkdir(skills(home, 'dropped-upstream'));
  await writeFile(join(skills(home, 'dropped-upstream'), 'SKILL.md'), 'an earlier upstream skill\n');
  await symlink(join('..', '..', '.agents', 'skills', 'dropped-upstream'), claude(home, 'dropped-upstream'));
  const earlier = [...NAMES.filter((name) => name !== added && name !== SKILL_PAGE), 'dropped-upstream'].sort();
  await writeFile(join(home, RECORD), JSON.stringify({ version: '0.2.1-c000000000000', names: earlier }));

  const restarted = await restart(hosted);
  await placed(home);

  await absent(skills(home, 'dropped-upstream'));
  await absent(claude(home, 'dropped-upstream'));
  expect(await tree(skills(home, added))).toEqual(await tree(join(SKILL_SET, added)));
  expect(await realpath(claude(home, added))).toBe(await realpath(skills(home, added)));
  expect(await readFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe(skillPage(restarted.house.origin));
  expect(await realpath(claude(home, SKILL_PAGE))).toBe(await realpath(skills(home, SKILL_PAGE)));
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);
  expect(await recorded(home)).toEqual(record(restarted.house.origin, NAMES));
});

it('removes every recorded skill and the record, installs nothing and asks House nothing for an empty list', async () => {
  const hosted = await host();
  await placed(hosted.home);
  await mkdir(skills(hosted.home, 'my-skill'));
  await writeFile(claude(hosted.home, 'my-note'), "the owner's\n");

  const restarted = await restart(hosted, { skills: [] });
  await until(async () => (await recorded(hosted.home)) === null);

  expect(await readdir(skills(hosted.home))).toEqual(['my-skill']);
  expect(await readdir(claude(hosted.home))).toEqual(['my-note']);
  await settle();
  expect(catalogueReads(restarted)).toBe(0);
});

it('places every skill at house login in the home of whoever runs it, with no resident, under the same record', async () => {
  const house = await startHouse();
  served(house);
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const { exit } = await logIn(house, home, planted);

  expect(exit).toBe(0);
  expect((await readdir(skills(home))).sort()).toEqual(NAMES);
  for (const name of NAMES) {
    expect(await realpath(claude(home, name))).toBe(await realpath(skills(home, name)));
  }
  expect(await readFile(join(skills(home, SKILL_PAGE), 'SKILL.md'), 'utf8')).toBe(skillPage(house.origin));
  expect(await recorded(home)).toEqual(record(house.origin, NAMES));
});

it("places no skill at house login when an earlier Kit's settings declined the Skill set, which reads as an empty list", async () => {
  const house = await startHouse();
  served(house);
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false }));

  const { exit } = await logIn(house, home, planted);

  expect(exit).toBe(0);
  await absent(skills(home));
  await absent(claude(home));
  expect(await recorded(home)).toBeNull();
  expect(house.requests.filter((request) => request.path === '/')).toEqual([]);
});

it('opens a conversation when an empty list leaves recorded skills it could not remove', async () => {
  const hosted = await host({
    skills: [],
    prepare: async (home) => {
      await mkdir(skills(home, FIRST), { recursive: true });
      await writeFile(join(home, RECORD), JSON.stringify({ version: KIT_RELEASE, names: [FIRST] }));
      await chmod(skills(home), 0o555);
      onTestFinished(() => chmod(skills(home), 0o700));
    },
  });
  await opened(hosted, 'conversation-1');

  expect(await until(() => /^kit: the skills could not be placed: EACCES: /m.test(hosted.kit.stderr()))).toBe(true);
});
