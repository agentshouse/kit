import { HouseRefusal, post } from './api.ts';
import { forgetAppGit } from './app-git.ts';
import { forgetEnrolment, forgetOwnAgent, readEnrolment, readOwnAgent } from './home.ts';

const KEPT_CONNECTION =
  "House had already disconnected this computer, so its own agent's connection stays until you revoke it on Connections.\n";

export async function logout(): Promise<void> {
  const enrolled = await readEnrolment();
  const ownAgent = await readOwnAgent();
  let refused = false;
  if (enrolled !== null) {
    try {
      await post(enrolled.house, '/kit/logout', {}, enrolled.credential);
    } catch (error) {
      if (!(error instanceof HouseRefusal && error.status === 401)) throw error;
      refused = true;
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
  if (ownAgent !== null && (enrolled === null || refused)) process.stdout.write(KEPT_CONNECTION);
}
