import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const list = fs.readdirSync;
const read = fs.readFileSync;
const logged = (line: string) => fs.appendFileSync(process.env.KIT_PROCESS_READS!, `${line}\n`);
fs.readdirSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  if (path === '/proc') logged('table');
  return (list as (path: fs.PathLike, ...rest: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readdirSync;
fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  if (typeof path === 'string' && /^\/proc\/\d+\/stat$/.test(path)) logged('process');
  return (read as (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
