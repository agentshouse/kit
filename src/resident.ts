import { readEnrolment } from './home.ts';
import { holdStream } from './stream.ts';

export async function resident(): Promise<void> {
  if ((await readEnrolment()) === null) {
    process.stderr.write('kit: this Environment is not enrolled; run kit login\n');
    process.exitCode = 1;
    return;
  }
  holdStream();
}
