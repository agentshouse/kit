import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';
import { temporaryHome } from './kit.ts';

const run = promisify(execFile);
const FOLLOW = fileURLToPath(new URL('../scripts/follow-skills.mjs', import.meta.url));
const WORKFLOW = new URL('../.github/workflows/follow-skills.yml', import.meta.url);
const MANIFEST = new URL('../package.json', import.meta.url);
const PACKAGE = '@agentshouse/skills';
const EARLIER = '0.1.0-c000000000001';
const LATEST = '0.1.0-c000000000002';

async function registry(latest: string): Promise<string> {
  const server: Server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (decodeURIComponent(request.url ?? '') !== `/${PACKAGE}`) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const versions = Object.fromEntries(
      [EARLIER, LATEST].map((version) => [
        version,
        {
          name: PACKAGE,
          version,
          dist: {
            tarball: `${origin}/${PACKAGE}/-/skills-${version}.tgz`,
            integrity: `sha512-${Buffer.alloc(64, version).toString('base64')}`,
          },
        },
      ]),
    );
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ name: PACKAGE, 'dist-tags': { latest }, versions }));
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  onTestFinished(() => new Promise<void>((closed) => server.close(() => closed())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function kit(pinned: string, origin: string): Promise<{ root: string; npm: Record<string, string> }> {
  const root = await temporaryHome();
  const npm = { ...process.env, npm_config_registry: origin, npm_config_cache: join(await temporaryHome(), 'cache') };
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'kit', version: '0.2.1', dependencies: { [PACKAGE]: pinned } }, null, 2)}\n`);
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: npm });
  return { root, npm };
}

async function follow(root: string, npm: Record<string, string>): Promise<string> {
  return (await run(process.execPath, [FOLLOW], { cwd: root, env: npm, encoding: 'utf8' })).stdout;
}

async function locked(root: string): Promise<unknown> {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  return { root: lock.packages['']!.dependencies, installed: lock.packages[`node_modules/${PACKAGE}`]!.version };
}

it("moves the Kit's dependency on the Skills package to npm's latest, exactly, in the manifest and the lock", async () => {
  const { root, npm } = await kit(EARLIER, await registry(LATEST));

  expect(await follow(root, npm)).toBe(`follow-skills: ${PACKAGE} moved from ${EARLIER} to ${LATEST}\n`);

  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies).toEqual({ [PACKAGE]: LATEST });
  expect(await locked(root)).toEqual({ root: { [PACKAGE]: LATEST }, installed: LATEST });
});

it("changes nothing when the Kit already depends on npm's latest", async () => {
  const { root, npm } = await kit(LATEST, await registry(LATEST));
  const manifest = await readFile(join(root, 'package.json'), 'utf8');
  const lock = await readFile(join(root, 'package-lock.json'), 'utf8');

  expect(await follow(root, npm)).toBe(`follow-skills: ${PACKAGE} ${LATEST} is npm's latest\n`);

  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest);
  expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
});

it('runs daily and lands the moved manifest and lock on main only when they changed, then has the publish run', async () => {
  const workflow = parse(await readFile(WORKFLOW, 'utf8')) as {
    on: { schedule: { cron: string }[] };
    jobs: { follow: { steps: { run?: string; with?: { ref?: string } }[] } };
  };
  const steps = workflow.jobs.follow.steps;
  const runs = steps.map((step) => step.run ?? '');
  const land = runs.find((run) => run.includes('git push'))!;

  expect(workflow.on.schedule).toEqual([{ cron: expect.stringMatching(/^\S+ \S+ \* \* \*$/) }]);
  expect(steps[0]!.with?.ref).toBe('main');
  expect(JSON.parse(await readFile(MANIFEST, 'utf8')).scripts['follow-skills']).toBe('node scripts/follow-skills.mjs');
  expect(runs.indexOf('npm run follow-skills')).toBeGreaterThan(-1);
  expect(runs.indexOf('npm run follow-skills')).toBeLessThan(runs.indexOf(land));
  expect(land.split('\n').map((line) => line.trim())).toEqual(
    expect.arrayContaining([
      'git add package.json package-lock.json',
      'if git diff --cached --quiet; then',
      'exit 0',
      'git push origin HEAD:main',
      'gh workflow run publish.yml --ref main',
    ]),
  );
  expect(land.indexOf('git diff --cached --quiet')).toBeLessThan(land.indexOf('git push origin HEAD:main'));
});
