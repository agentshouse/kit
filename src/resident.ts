import { Agents } from './agents.ts';
import { house } from './api.ts';
import { Conversations, type Input } from './conversations.ts';
import { readEnrolment } from './home.ts';
import { holdStream, type Frame, type Stream } from './stream.ts';

function report(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

function logged(work: Promise<unknown>): void {
  work.catch(report);
}

export async function resident(): Promise<void> {
  if ((await readEnrolment()) === null) {
    process.stderr.write('kit: this Environment is not enrolled; run kit login\n');
    process.exitCode = 1;
    return;
  }
  const agents = new Agents(house);
  let stream: Stream | null = null;
  const conversations = new Conversations({
    house,
    agents,
    send: (frame) => stream?.send(frame) ?? false,
  });

  await house.deliver('/kit/restarted', {}).catch(report);
  logged(agents.refresh());
  stream = holdStream({
    opened: () => undefined,
    frame: (received: Frame) => {
      if (received.type === 'work_available' && received.subject === 'agents') logged(agents.refresh());
      if (received.type === 'input') conversations.input(received as unknown as Input);
    },
  });
}
