import { HouseRefusal, post } from './api.ts';
import { forgetEnrolment, readEnrolment } from './home.ts';

export async function logout(): Promise<void> {
  const enrolled = await readEnrolment();
  if (enrolled === null) {
    process.stdout.write('This computer is not connected to House.\n');
    return;
  }
  try {
    await post(enrolled.house, '/kit/logout', {}, enrolled.credential);
  } catch (error) {
    if (!(error instanceof HouseRefusal && error.status === 401)) throw error;
  }
  await forgetEnrolment(enrolled);
  process.stdout.write(`Environment ${enrolled.environment} is disconnected; kit login reconnects it.\n`);
}
