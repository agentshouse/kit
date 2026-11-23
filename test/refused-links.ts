import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

fs.promises.link = (async (existing: fs.PathLike, created: fs.PathLike) => {
  throw Object.assign(new Error(`EXDEV: cross-device link not permitted, link '${String(existing)}' -> '${String(created)}'`), { code: 'EXDEV', syscall: 'link' });
}) as typeof fs.promises.link;
syncBuiltinESMExports();
