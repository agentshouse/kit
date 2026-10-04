import { readConfiguration, writeConfiguration } from './home.ts';

const skills = !process.argv.slice(2).includes('--no-skills');
const stored = await readConfiguration();
await writeConfiguration({ skills });
if (stored.skills !== skills) process.stdout.write('changed\n');
