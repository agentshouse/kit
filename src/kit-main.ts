#!/usr/bin/env node
import { setGlobalProxyFromEnv } from 'node:http';
import { login } from './login.ts';
import { logout } from './logout.ts';
import { resident } from './resident.ts';

declare module 'node:http' {
  function setGlobalProxyFromEnv(proxyEnv?: NodeJS.ProcessEnv): () => void;
}

const [command, ...argv] = process.argv.slice(2);
setGlobalProxyFromEnv();

async function run(): Promise<void> {
  if (command === 'login') return login(argv);
  if (command === 'logout') return logout();
  if (command === 'resident') return resident();
  process.stderr.write('usage: kit <login|logout|resident>\n');
  process.exitCode = 2;
}

run().catch((error: unknown) => {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
