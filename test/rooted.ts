import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as Record<string, unknown>;
const promises = require('node:fs/promises') as Record<string, unknown>;
const root = process.env.KIT_TEST_ROOT!;
const ROOTS = ['/opt/house-kit', '/usr/local/bin', '/etc/systemd/system', '/agents', '/run/systemd/system', '/kit-home'];

function mapped(path: unknown): unknown {
  if (typeof path !== 'string') return path;
  return ROOTS.some((held) => path === held || path.startsWith(`${held}/`)) ? `${root}${path}` : path;
}

const SINGLE = ['existsSync', 'readFileSync', 'lstat', 'readdir', 'rm', 'rmdir', 'mkdir', 'readFile', 'writeFile', 'stat', 'access'];
const DOUBLE = ['rename', 'cp'];

for (const [module, names] of [
  [fs, ['existsSync', 'readFileSync']],
  [promises, [...SINGLE.filter((name) => !name.endsWith('Sync')), ...DOUBLE]],
] as const) {
  for (const name of names) {
    const held = module[name] as (...args: unknown[]) => unknown;
    const pair = (DOUBLE as readonly string[]).includes(name);
    module[name] = (...args: unknown[]) => held(mapped(args[0]), ...(pair ? [mapped(args[1]), ...args.slice(2)] : args.slice(1)));
  }
}
if (process.env.KIT_TEST_UID0 === '1') process.getuid = () => 0;
syncBuiltinESMExports();
