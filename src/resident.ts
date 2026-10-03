import { Agents } from './agents.ts';
import { house } from './api.ts';
import { readEnrolment } from './home.ts';
import { holdStream, type Frame } from './stream.ts';

function logged(work: Promise<unknown>): void {
  work.catch((error: unknown) => {
    process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

export async function resident(): Promise<void> {
  if ((await readEnrolment()) === null) {
    process.stderr.write('kit: this Environment is not enrolled; run kit login\n');
    process.exitCode = 1;
    return;
  }
  const agents = new Agents(house);

  holdStream((received: Frame) => {
    if (received.type === 'work_available' && received.subject === 'agents') logged(agents.refresh());
  });
  logged(agents.refresh());
}
