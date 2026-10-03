#!/usr/bin/env node
import { login } from './login.ts';
import { resident } from './resident.ts';

const [command, ...argv] = process.argv.slice(2);

async function run(): Promise<void> {
  if (command === 'login') return login(argv);
  if (command === 'resident') return resident();
  process.stderr.write('usage: kit <login|resident>\n');
  process.exitCode = 2;
}

run().catch((error: unknown) => {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
