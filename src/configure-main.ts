import { storedConfiguration, writeConfiguration } from './home.ts';

process.env.HOUSE_KIT_PREFIX ||= '/kit-home/kit';

const skills = !process.argv.slice(2).includes('--no-skills');
const stored = await storedConfiguration();
await writeConfiguration({ ...stored, skills });
if ((stored.skills !== false) !== skills) process.stdout.write('changed\n');
