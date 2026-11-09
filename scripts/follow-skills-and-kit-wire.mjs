import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PACKAGES = ['@agentshouse/skills', '@agentshouse/kit-wire'];

function pinned(name) {
  return JSON.parse(readFileSync('package.json', 'utf8')).dependencies[name];
}

const moved = PACKAGES.map((name) => ({
  name,
  latest: execFileSync('npm', ['view', `${name}@latest`, 'version', '--prefer-online'], { encoding: 'utf8' }).trim(),
})).filter(({ name, latest }) => latest !== pinned(name));
if (moved.length === 0) {
  process.stdout.write(`The Kit installs npm's latest ${PACKAGES.join(' and ')}\n`);
} else {
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...moved.map(({ name, latest }) => `${name}@${latest}`),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  process.stdout.write(`The Kit installs ${moved.map(({ name }) => `${name} ${pinned(name)}`).join(' and ')}\n`);
}
