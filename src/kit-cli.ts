import { parseArgs } from 'node:util';
import { answerGitCredential } from './app-git.ts';
import { chatgpt } from './chatgpt.ts';
import { login } from './login.ts';
import { logout } from './logout.ts';
import { proxyUnlessRelayed } from './relay.ts';
import { resident } from './resident.ts';

interface Command {
  usage: string;
  about: string;
  operands: number;
  run(operands: string[]): Promise<void>;
}

const USAGE = 'usage: kit <login|logout|resident|chatgpt>\n';
const COMMANDS = new Map<string, Command>([
  [
    'logout',
    {
      usage: 'usage: kit logout',
      about: "disconnects this computer, stops the Kit process and ends your own agent's connection",
      operands: 0,
      run: logout,
    },
  ],
  [
    'resident',
    {
      usage: 'usage: kit resident',
      about: "keeps this Environment connected; Kit's service runs it",
      operands: 0,
      run: resident,
    },
  ],
  [
    'git-credential',
    {
      usage: 'usage: kit git-credential <get|store|erase>',
      about: "answers git with your own agent's House credential; git runs it",
      operands: 1,
      run: ([operation]) => answerGitCredential(operation),
    },
  ],
]);

const [command, ...argv] = process.argv.slice(2);
proxyUnlessRelayed();

async function run(): Promise<void> {
  if (command === 'login') return login(argv);
  if (command === 'chatgpt') return chatgpt(argv);
  if (command === '--help') {
    parseArgs({ args: argv });
    process.stdout.write(USAGE);
    return;
  }
  const chosen = COMMANDS.get(command ?? '');
  if (chosen === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const { values, positionals } = parseArgs({ args: argv, options: { help: { type: 'boolean', default: false } }, allowPositionals: true });
  if (positionals.length > chosen.operands) throw new Error(`unexpected argument ${positionals[chosen.operands]}; ${chosen.usage}`);
  if (values.help) {
    process.stdout.write(`${chosen.usage}\n  ${chosen.about}\n`);
    return;
  }
  return chosen.run(positionals);
}

run().catch((error: unknown) => {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
