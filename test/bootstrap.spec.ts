import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const WINDOWS = fileURLToPath(new URL('../bin/connect-windows.ps1', import.meta.url));

async function published(): Promise<string> {
  const home = await temporaryHome();
  const script = join(home, 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8')).replace('__IMAGE_DIGEST__', 'a'.repeat(64)).replace('__KIT_VERSION__', '0.2.1-alpha.1'),
  );
  return script;
}

function bootstrap(script: string, argv: string[]) {
  const ran = spawnSync('bash', [script, ...argv], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

it('leaves the release exactly one image digest and one Kit version to fill', async () => {
  const linux = await readFile(LINUX, 'utf8');
  const windows = await readFile(WINDOWS, 'utf8');

  expect(spawnSync('bash', ['-n', LINUX]).status).toBe(0);
  expect(linux.split('__IMAGE_DIGEST__')).toHaveLength(2);
  expect(linux.split('__KIT_VERSION__')).toHaveLength(2);
  expect(windows.split('__IMAGE_DIGEST__')).toHaveLength(2);
  expect(windows).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
});

it('installs natively the Node.js release the package runs on', async () => {
  const { engines } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  };

  expect(await readFile(LINUX, 'utf8')).toContain(`\nNODE_VERSION=${engines.node}\n`);
});

it('refuses to run before the release fills it', () => {
  expect(bootstrap(LINUX, [])).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: this bootstrap has not been published with an immutable release\n',
  });
});

it('enrolls with a credential only on a server', async () => {
  expect(bootstrap(await published(), ['--enroll', 'environment-one'])).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: --enroll enrolls a server; add --linux\n',
  });
});

it('refuses a native install on any host but the one selected Linux platform before changing it', async () => {
  const refused = bootstrap(await published(), ['--linux', '--house', 'https://agents.house', '--enroll', 'environment-one']);

  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe('');
  expect(refused.stderr).toMatch(/^kit_bootstrap_refused: --linux runs only on Ubuntu 26\.04 LTS on amd64, not Debian GNU\/Linux 12 \(bookworm\) on (amd64|arm64)\n$/);
});

it('leaves a native host its own kit and house rather than forwarding to them', async () => {
  expect(bootstrap(await published(), ['--linux', 'house', 'git', 'push', '--owner'])).toMatchObject({
    status: 1,
    stderr: "kit_bootstrap_refused: --linux puts kit and house on this host's PATH; run house there directly\n",
  });
});
