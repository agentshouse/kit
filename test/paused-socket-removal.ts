import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const rm = fs.promises.rm;
fs.promises.rm = (async (path: fs.PathLike, options?: fs.RmOptions) => {
  if (basename(String(path)) === 'owner.sock') {
    process.stderr.write('kit-test: removing the owner socket\n');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    process.stdin.pause();
  }
  await rm(path, options);
}) as typeof fs.promises.rm;
syncBuiltinESMExports();
