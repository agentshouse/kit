import { startService } from './service.ts';

try {
  if (startService()) process.stdout.write('started\n');
} catch (error) {
  process.stderr.write(`kit: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
