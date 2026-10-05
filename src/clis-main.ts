import { setGlobalProxyFromEnv } from 'node:http';
import { post } from './api.ts';
import { CLIS, below, locate, versionOf } from './clis.ts';
import { readEnrolment } from './home.ts';

setGlobalProxyFromEnv();
try {
  const { house, credential } = (await readEnrolment())!;
  const { agents } = await post<{ agents: string[] }>(house, '/kit/agents/desired', {}, credential);
  for (const kind of agents) {
    const cli = await locate(kind);
    if (cli === null) continue;
    const release = await versionOf(cli);
    if (release === null) continue;
    const { bin, minimum } = CLIS[kind]!;
    process.stdout.write(`${[bin, cli, release, minimum, below(release, minimum) ? 'old' : 'current'].join('\t')}\n`);
  }
} catch (error) {
  process.stderr.write(`kit: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
