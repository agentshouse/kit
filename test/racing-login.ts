import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';

const rename = fs.promises.rename;
fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
  await rename(from, to);
  if (basename(String(to)) !== 'disconnected.json') return;
  const enrolment = join(dirname(String(to)), 'credential.json');
  const stored = { ...JSON.parse(fs.readFileSync(enrolment, 'utf8')), credential: process.env.KIT_RACING_CREDENTIAL };
  fs.writeFileSync(`${enrolment}.login`, JSON.stringify(stored));
  fs.renameSync(`${enrolment}.login`, enrolment);
}) as typeof fs.promises.rename;
syncBuiltinESMExports();
