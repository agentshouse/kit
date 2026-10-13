import { execFileSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPOSITORY = process.argv[2] ?? 'https://github.com/mattpocock/skills';
const CATEGORIES = ['engineering', 'productivity'];
const LEFT_OUT = new Set(['setup-matt-pocock-skills']);
const SKILLS = 'skills';
const RECORD = 'skills-upstream.json';

async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

const upstream = await mkdtemp(join(tmpdir(), 'kit-skills-'));
try {
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', 'main', REPOSITORY, upstream], { stdio: 'inherit' });
  const [commit, date] = execFileSync('git', ['-C', upstream, 'show', '--no-patch', '--format=%H %cd', '--date=format-local:%Y-%m-%d'], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
  })
    .trim()
    .split(' ');

  const skills = [];
  for (const category of CATEGORIES) {
    const root = join(upstream, SKILLS, category);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !LEFT_OUT.has(entry.name)) skills.push({ name: entry.name, source: join(root, entry.name) });
    }
  }
  const names = skills.map((skill) => skill.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) throw new Error(`upstream names the skill ${twice} in more than one category`);

  await rm(SKILLS, { recursive: true, force: true });
  await mkdir(SKILLS);
  for (const { name, source } of skills) {
    await cp(source, join(SKILLS, name), { recursive: true });
    if (await absent(join(SKILLS, name, 'LICENSE'))) await copyFile(join(upstream, 'LICENSE'), join(SKILLS, name, 'LICENSE'));
  }
  await writeFile(RECORD, `${JSON.stringify({ repository: REPOSITORY, commit, date }, null, 2)}\n`);
  process.stdout.write(`skills: ${names.length} from ${REPOSITORY} at ${commit} (${date})\n`);
} finally {
  await rm(upstream, { recursive: true, force: true });
}
