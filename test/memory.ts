import { writeFileSync } from 'node:fs';

process.on('exit', () => writeFileSync(process.env.KIT_TEST_PEAK_MEMORY!, String(process.resourceUsage().maxRSS * 1024)));
