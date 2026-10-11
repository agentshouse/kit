import { readFileSync } from 'node:fs';
import { writeEnrolment } from './home.ts';

const [house, environment] = process.argv.slice(2);
const relay = process.env.HOUSE_KIT_RELAY || undefined;
await writeEnrolment({
  house: house!,
  ...(relay === undefined ? {} : { relay }),
  environment: environment!,
  credential: readFileSync(0, 'utf8').trim(),
});
