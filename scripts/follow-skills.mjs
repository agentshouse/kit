import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PACKAGE = '@agentshouse/skills';

function pinned() {
  return JSON.parse(readFileSync('package.json', 'utf8')).dependencies[PACKAGE];
}

const held = pinned();
const latest = execFileSync('npm', ['view', `${PACKAGE}@latest`, 'version', '--prefer-online'], { encoding: 'utf8' }).trim();
if (latest === held) {
  process.stdout.write(`follow-skills: ${PACKAGE} ${held} is npm's latest\n`);
} else {
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE}@${latest}`],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  process.stdout.write(`follow-skills: ${PACKAGE} moved from ${held} to ${pinned()}\n`);
}
