import { killDescendants } from './acp.ts';
import { Agents } from './agents.ts';
import { house } from './api.ts';
import { Conversations, type Input } from './conversations.ts';
import { readEnrolment } from './home.ts';
import { SignIns, type SignIn } from './sign-in.ts';
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
  let reported = false;
  const idle = () => conversations.idle() && signIns.idle();
  const changed = () => {
    if (!idle()) {
      reported = false;
    } else if (!reported) {
      reported = true;
      logged(house.deliver('/kit/idle', {}, idle));
    }
  };
  const conversations: Conversations = new Conversations({
    house,
    agents,
    send: (frame) => stream?.send(frame) ?? false,
    changed,
  });
  const signIns: SignIns = new SignIns(house, agents, changed);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      killDescendants();
      process.kill(process.pid, signal);
    });
  }

  await house.deliver('/kit/restarted', {}).catch(report);
  logged(agents.refresh());
  stream = holdStream({
    opened: () => {
      conversations.replay();
      changed();
    },
    frame: (received: Frame) => {
      if (received.type === 'work_available' && received.subject === 'agents') logged(agents.refresh());
      if (received.type === 'input') {
        reported = false;
        if (received.kind === 'sign_in') signIns.start(received as unknown as SignIn);
        else conversations.input(received as unknown as Input);
      }
    },
  });
}
