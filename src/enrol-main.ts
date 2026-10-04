import { readFileSync } from 'node:fs';
import { writeEnrolment } from './home.ts';

const [house, environment] = process.argv.slice(2);
await writeEnrolment({ house: house!, environment: environment!, credential: readFileSync(0, 'utf8').trim() });
