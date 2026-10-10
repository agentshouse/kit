import { HouseRefusal, post } from './api.ts';
import { forgetAppGit } from './app-git.ts';
import { forgetEnrolment, forgetOwnAgent, readEnrolment } from './home.ts';

export async function logout(): Promise<void> {
  const enrolled = await readEnrolment();
  if (enrolled !== null) {
    try {
      await post(enrolled.house, '/kit/logout', {}, enrolled.credential);
    } catch (error) {
      if (!(error instanceof HouseRefusal && error.status === 401)) throw error;
    }
    await forgetEnrolment(enrolled);
  }
  await forgetAppGit();
  await forgetOwnAgent();
  process.stdout.write(
    enrolled === null
      ? 'This computer is not connected to House.\n'
      : `Environment ${enrolled.environment} is disconnected; kit login reconnects it.\n`,
  );
}
