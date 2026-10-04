import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { recordStart } from './started.ts';

export interface DeviceLogin {
  argv: string[];
  link: string;
  code: string | null;
  output: string;
}

const CLAUDE_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic-client&response_type=code' +
  '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference' +
  '&code_challenge=synthetic-challenge&code_challenge_method=S256&state=synthetic-state';

export const DEVICE_LOGINS: Record<string, DeviceLogin> = {
  'codex-acp': {
    argv: ['cli', 'login', '--device-auth'],
    link: 'https://auth.openai.com/codex/device',
    code: 'C3P4-RMXOG',
    output: [
      '',
      'Welcome to Codex [v\u001b[90m0.160.0\u001b[0m]',
      "\u001b[90mOpenAI's command-line coding agent\u001b[0m",
      '',
      'Follow these steps to sign in with ChatGPT using device code authorization:',
      '',
      '1. Open this link in your browser and sign in to your account',
      '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
      '',
      '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
      '   \u001b[94mC3P4-RMXOG\u001b[0m',
      '',
      '\u001b[90mDevice codes are a common phishing target. Never share this code.\u001b[0m',
      '',
    ].join('\n'),
  },
  'claude-agent-acp': {
    argv: ['--cli', 'auth', 'login', '--claudeai'],
    link: CLAUDE_LINK,
    code: null,
    output: `If the browser didn't open, visit: ${CLAUDE_LINK}\nPaste code here if prompted > `,
  },
  'grok-build': {
    argv: ['login', '--device-auth'],
    link: 'https://accounts.x.ai/oauth2/device?user_code=E4ED-ZJ4V',
    code: 'E4ED-ZJ4V',
    output: [
      '',
      'To sign in, open this URL in your browser:',
      '',
      '  https://accounts.x.ai/oauth2/device?user_code=E4ED-ZJ4V',
      '',
      'Confirm this code in your browser:',
      '',
      '  E4ED-ZJ4V',
      '',
      "Only continue with a code you requested. Don't share it with anyone.",
      '',
      'Waiting for authorization...',
      '',
    ].join('\n'),
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recordStart('device-login');
  const kind = process.env.ADAPTER_KIND!;
  const home = process.env.HOUSE_KIT_HOME!;
  const argv = process.argv.slice(2);
  const login = DEVICE_LOGINS[kind]!;
  const log = (entry: Record<string, unknown>) =>
    appendFileSync(join(home, 'login.log'), `${JSON.stringify({ kind, ...entry })}\n`);
  log({ pid: process.pid, argv });
  if (argv.join(' ') !== login.argv.join(' ')) {
    process.stderr.write(`unknown arguments: ${argv.join(' ')}\n`);
    process.exit(2);
  }
  process.stdout.write(login.output);
  if (login.code === null) {
    const pasted = await new Promise<string>((resolve) => createInterface({ input: process.stdin }).once('line', resolve));
    log({ pasted: createHash('sha256').update(pasted).digest('hex') });
  } else {
    const finished = join(home, 'device-login', kind);
    while (!existsSync(finished)) await new Promise((resolve) => setTimeout(resolve, 50));
    const refusal = readFileSync(finished, 'utf8');
    if (refusal !== '') {
      process.stderr.write(`${refusal}\n`);
      process.exit(1);
    }
  }
  mkdirSync(join(home, 'signed-in'), { recursive: true });
  writeFileSync(join(home, 'signed-in', kind), '');
  process.exit(0);
}
