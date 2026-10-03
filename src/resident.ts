import { readEnrolment } from './home.ts';
import { holdStream } from './stream.ts';

export async function resident(): Promise<void> {
  const enrolment = await readEnrolment();
  if (enrolment === null) {
    process.stderr.write('kit: this Environment is not enrolled; run kit login\n');
    process.exitCode = 1;
    return;
  }
  holdStream(enrolment.house, enrolment.credential, {
    opened: () => undefined,
    frame: () => undefined,
  });
}
