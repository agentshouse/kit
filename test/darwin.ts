import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const read = fs.readdirSync;
Object.defineProperty(process, 'platform', { value: 'darwin' });
fs.readdirSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  if (path === '/proc') throw Object.assign(new Error("ENOENT: no such file or directory, scandir '/proc'"), { code: 'ENOENT' });
  return (read as (path: fs.PathLike, ...rest: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readdirSync;
syncBuiltinESMExports();
