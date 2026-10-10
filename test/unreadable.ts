import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const read = fs.readFileSync;
fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  if (typeof path === 'string' && /^\/proc\/\d+\/stat$/.test(path) && fs.existsSync(process.env.KIT_UNREADABLE!)) {
    throw Object.assign(new Error(`EIO: i/o error, open '${path}'`), { code: 'EIO' });
  }
  return (read as (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
