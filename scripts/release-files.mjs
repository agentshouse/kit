import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLIS, adapterArchive } from '../src/clis.ts';

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const QUIET = ['--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'];

const [packed, given] = process.argv.slice(2);
if (packed === undefined || given === undefined) {
  process.stderr.write('usage: node scripts/release-files.mjs <packed kit.tgz> <release directory>\n');
  process.exit(2);
}
const release = resolve(given);
const work = mkdtempSync(join(tmpdir(), 'kit-release-'));
const npm = (args, cwd = work) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

try {
  mkdirSync(release, { recursive: true });
  const prefix = join(work, 'kit');
  npm(['install', '--global', '--prefix', prefix, ...QUIET, resolve(packed)]);
  const installed = join(prefix, 'lib', 'node_modules', '@agentshouse', 'kit');
  const { version, peerDependencies } = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const pty = join(installed, 'node_modules', '@lydell', 'node-pty');
  const { version: ptyVersion } = JSON.parse(readFileSync(join(pty, 'package.json'), 'utf8'));
  for (const platform of PLATFORMS) {
    const placed = join(installed, 'node_modules', '@lydell', `node-pty-${platform}`);
    if (existsSync(placed)) continue;
    const [{ filename }] = JSON.parse(npm(['pack', '--json', '--pack-destination', work, `@lydell/node-pty-${platform}@${ptyVersion}`]));
    mkdirSync(placed, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, filename), '-C', placed, '--strip-components=1', '--no-same-owner']);
  }
  execFileSync('tar', ['-czf', join(release, `kit-${version}.tar.gz`), '-C', prefix, 'lib', 'bin']);
  for (const [kind, { adapter }] of Object.entries(CLIS)) {
    if (adapter === null) continue;
    const adapterPrefix = join(work, kind);
    npm(['install', '--prefix', adapterPrefix, '--no-save', '--omit=optional', ...QUIET, `${adapter.package}@${peerDependencies[adapter.package]}`]);
    execFileSync('tar', ['-czf', join(release, adapterArchive(kind)), '-C', adapterPrefix, 'node_modules']);
  }
  process.stdout.write(`release files of Kit ${version} in ${release}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
