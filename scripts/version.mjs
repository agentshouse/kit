import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const RELEASED = ['Dockerfile', 'bin/connect-linux.sh', 'bin/connect-windows.ps1'];

const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const content = createHash('sha256');
for (const path of [...packed.files.map((file) => file.path), ...RELEASED].sort()) {
  content.update(`${path}\0`).update(readFileSync(path)).update('\0');
}
const [line] = packed.version.split('-');
process.stdout.write(`${line}-c${content.digest('hex').slice(0, 12)}\n`);
