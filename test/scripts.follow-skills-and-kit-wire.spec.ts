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
const FOLLOW = fileURLToPath(new URL('../scripts/follow-skills-and-kit-wire.mjs', import.meta.url));
const WORKFLOW = new URL('../.github/workflows/follow-skills-and-kit-wire.yml', import.meta.url);
const MANIFEST = new URL('../package.json', import.meta.url);
const SKILLS = '@agentshouse/skills';
const WIRE = '@agentshouse/kit-wire';
const EARLIER = '0.1.0-c000000000001';
const LATEST = '0.1.0-c000000000002';

type Pins = Record<typeof SKILLS | typeof WIRE, string>;

async function registry(): Promise<string> {
  const server: Server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const name = [SKILLS, WIRE].find((candidate) => decodeURIComponent(request.url ?? '') === `/${candidate}`);
    if (name === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const versions = Object.fromEntries(
      [EARLIER, LATEST].map((version) => [
        version,
        {
          name,
          version,
          dist: {
            tarball: `${origin}/${name}/-/${name.split('/')[1]}-${version}.tgz`,
            integrity: `sha512-${Buffer.alloc(64, `${name}${version}`).toString('base64')}`,
          },
        },
      ]),
    );
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ name, 'dist-tags': { latest: LATEST }, versions }));
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  onTestFinished(() => new Promise<void>((closed) => server.close(() => closed())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function kit(pins: Pins): Promise<{ root: string; npm: Record<string, string> }> {
  const root = await temporaryHome();
  const npm = { ...process.env, npm_config_registry: await registry(), npm_config_cache: join(await temporaryHome(), 'cache') };
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'kit', version: '0.2.1', dependencies: pins }, null, 2)}\n`);
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
  return {
    root: lock.packages['']!.dependencies,
    installed: { [SKILLS]: lock.packages[`node_modules/${SKILLS}`]!.version, [WIRE]: lock.packages[`node_modules/${WIRE}`]!.version },
  };
}

it.each([
  ['both packages', { [SKILLS]: EARLIER, [WIRE]: EARLIER }, `The Kit installs ${SKILLS} ${LATEST} and ${WIRE} ${LATEST}\n`],
  ['the Skills package', { [SKILLS]: EARLIER, [WIRE]: LATEST }, `The Kit installs ${SKILLS} ${LATEST}\n`],
  ['the Kit wire package', { [SKILLS]: LATEST, [WIRE]: EARLIER }, `The Kit installs ${WIRE} ${LATEST}\n`],
])("moves the Kit's dependency on %s to npm's latest, exactly, in the manifest and the lock, naming what moved", async (_, pins, moved) => {
  const { root, npm } = await kit(pins);

  const said = await follow(root, npm);

  const latest = { [SKILLS]: LATEST, [WIRE]: LATEST };
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies).toEqual(latest);
  expect(await locked(root)).toEqual({ root: latest, installed: latest });
  expect(said).toBe(moved);
});

it("changes nothing when the Kit already depends on npm's latest of both packages", async () => {
  const { root, npm } = await kit({ [SKILLS]: LATEST, [WIRE]: LATEST });
  const manifest = await readFile(join(root, 'package.json'), 'utf8');
  const lock = await readFile(join(root, 'package-lock.json'), 'utf8');

  expect(await follow(root, npm)).toBe(`The Kit installs npm's latest ${SKILLS} and ${WIRE}\n`);

  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest);
  expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
});

it('runs daily and lands the moved manifest and lock on main under the subject the follower names, only when they changed, then has the publish run', async () => {
  const workflow = parse(await readFile(WORKFLOW, 'utf8')) as {
    on: { schedule: { cron: string }[] };
    jobs: { follow: { steps: { id?: string; run?: string; env?: Record<string, string>; with?: { ref?: string } }[] } };
  };
  const steps = workflow.jobs.follow.steps;
  const followed = steps.find((step) => step.id === 'follow')!;
  const land = steps.find((step) => step.run?.includes('git push'))!;
  const lines = (step: { run?: string }) => step.run!.split('\n').map((line) => line.trim());

  expect(workflow.on.schedule).toEqual([{ cron: expect.stringMatching(/^\S+ \S+ \* \* \*$/) }]);
  expect(steps[0]!.with?.ref).toBe('main');
  expect(JSON.parse(await readFile(MANIFEST, 'utf8')).scripts['follow-skills-and-kit-wire']).toBe('node scripts/follow-skills-and-kit-wire.mjs');
  expect(lines(followed)).toEqual(
    expect.arrayContaining(['subject=$(npm run --silent follow-skills-and-kit-wire)', 'echo "subject=$subject" >> "$GITHUB_OUTPUT"']),
  );
  expect(steps.indexOf(followed)).toBeLessThan(steps.indexOf(land));
  expect(land.env?.SUBJECT).toBe('${{ steps.follow.outputs.subject }}');
  expect(lines(land)).toEqual(
    expect.arrayContaining([
      'git add package.json package-lock.json',
      'if git diff --cached --quiet; then',
      'exit 0',
      'commit --quiet --message "$SUBJECT"',
      'git push origin HEAD:main',
      'gh workflow run publish.yml --ref main',
    ]),
  );
  expect(land.run!.indexOf('git diff --cached --quiet')).toBeLessThan(land.run!.indexOf('git push origin HEAD:main'));
});
