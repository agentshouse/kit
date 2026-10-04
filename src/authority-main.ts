import { setGlobalProxyFromEnv } from 'node:http';
import { HouseRefusal, post } from './api.ts';
import { readEnrolment } from './home.ts';

function unanswered(error: unknown): boolean {
  return error instanceof HouseRefusal ? error.status >= 500 : error instanceof TypeError && error.message === 'fetch failed';
}

setGlobalProxyFromEnv();
try {
  const { house, credential } = (await readEnrolment())!;
  try {
    await post(house, '/kit/agents/desired', {}, credential);
  } catch (error) {
    if (!unanswered(error)) throw error;
    process.stderr.write(`kit: House did not answer, so the stored credential stands: ${(error as Error).message}\n`);
  }
} catch (error) {
  process.stderr.write(`kit: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
