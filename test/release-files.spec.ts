import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLIS, adapterArchive } from '../src/clis.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_FILES = join(ROOT, 'scripts', 'release-files.mjs');
const KIT_PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

let release: string;

function entries(archive: string): string[] {
  return execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
}

let packed: string;

afterAll(async () => {
  await rm(packed, { recursive: true, force: true });
  await rm(release, { recursive: true, force: true });
});

beforeAll(async () => {
  packed = await mkdtemp(join(tmpdir(), 'kit-packed-'));
  release = await mkdtemp(join(tmpdir(), 'kit-release-files-'));
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npm', ['pack', '--pack-destination', packed, '--loglevel=error'], { cwd: ROOT, stdio: 'ignore' });
  const [tarball] = await readdir(packed);
  const built = spawnSync(process.execPath, [RELEASE_FILES, join(packed, tarball!), release], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`release-files failed: ${built.stderr}`);
// Ten minutes cover building, packing and installing the Kit's and both adapters' dependencies from npm on a cold cache.
}, 600_000);

it('builds one Kit archive with the Kit package, its dependencies, its bin links and the pty prebuilds of every native platform', () => {
  const listed = entries(join(release, `kit-${KIT_PACKAGE.version}.tar.gz`));

  expect(listed).toContainEqual(expect.stringMatching(/ bin\/kit -> \.\.\/lib\/node_modules\/@agentshouse\/kit\/dist\/kit-main\.js$/));
  expect(listed).toContainEqual(expect.stringMatching(/ bin\/house -> \.\.\/lib\/node_modules\/@agentshouse\/kit\/dist\/house-main\.js$/));
  expect(listed).toContainEqual(expect.stringMatching(/ lib\/node_modules\/@agentshouse\/kit\/node_modules\/@agentshouse\/skills\/package\.json$/));
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
    expect(listed).toContainEqual(expect.stringMatching(new RegExp(` lib/node_modules/@agentshouse/kit/node_modules/@lydell/node-pty-${platform}/package\\.json$`)));
  }
});

it('builds one archive per adapter the package pins, holding that adapter and its bin but no optional platform package', async () => {
  const adapters = Object.keys(CLIS).filter((kind) => CLIS[kind]!.adapter !== null);
  expect((await readdir(release)).sort()).toEqual([...adapters.map((kind) => adapterArchive(kind)), `kit-${KIT_PACKAGE.version}.tar.gz`].sort());
  for (const kind of adapters) {
    const adapter = CLIS[kind]!.adapter!;
    const listed = entries(join(release, adapterArchive(kind)));
    expect(adapterArchive(kind)).toBe(`${kind}-${KIT_PACKAGE.peerDependencies[adapter.package]}.tar.gz`);
    expect(listed).toContainEqual(expect.stringMatching(new RegExp(` node_modules/${adapter.package}/package\\.json$`)));
    expect(listed).toContainEqual(expect.stringMatching(new RegExp(` node_modules/\\.bin/${adapter.bin} -> `)));
    expect(listed.filter((line) => /node_modules\/(@openai\/codex-|@anthropic-ai\/claude-agent-sdk-)/.test(line))).toEqual([]);
  }
});
