import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agents } from './agents.ts';
import { house } from './api.ts';
import { received } from './bridge.ts';
import { Conversations, type Input } from './conversations.ts';
import { LocalCopies } from './copies.ts';
import { agentBase, enrolled, kitHome } from './home.ts';
import { killDescendants } from './scope.ts';
import { quoted } from './shell.ts';
import { SignIns, type SignIn } from './sign-in.ts';
import { placeSkillSet } from './skills.ts';
import { holdStream, type Frame, type Stream } from './stream.ts';
import { Updates, type Update } from './update.ts';
import { codexLauncher } from './work.ts';

function report(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

function logged(work: Promise<unknown>): void {
  work.catch(report);
}

async function installShim(path: string, module: string): Promise<void> {
  const main = fileURLToPath(new URL(`./${module}${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(main)} "$@"\n`, { mode: 0o755 });
}

async function serveOwner(copies: LocalCopies): Promise<void> {
  const socketPath = join(kitHome(), 'owner.sock');
  await rm(socketPath, { force: true });
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== '/git/push') {
        response.writeHead(404).end();
        return;
      }
      const { cwd, commit } = JSON.parse(await received(request)) as { cwd: string; commit: string };
      const pushed = await copies.push(cwd, commit, copies.owner);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pushed));
    } catch (error) {
      response.writeHead(502).end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(socketPath);
  await once(server, 'listening');
}

function connected(): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(kitHome(), () => {
      if (!enrolled()) return;
      watcher.close();
      resolve();
    });
    if (!enrolled()) {
      process.stderr.write('kit: this Environment is not connected; run kit login\n');
      return;
    }
    watcher.close();
    resolve();
  });
}

export async function resident(): Promise<void> {
  await connected();
  watch(kitHome(), () => {
    if (enrolled()) return;
    killDescendants();
    process.exit(1);
  });
  await placeSkillSet();
  await mkdir(agentBase(), { recursive: true });
  process.env.HOUSE_KIT_RESIDENT = String(process.pid);
  const agents = new Agents(house);
  const copies = new LocalCopies(house);
  await copies.load();
  await installShim(join(kitHome(), 'shim', 'git'), 'git-main');
  await installShim(codexLauncher(), 'codex-main');
  await serveOwner(copies);
  let stream: Stream | null = null;
  let reported = false;
  const idle = () => conversations.idle() && signIns.idle();
  const changed = () => {
    if (!idle()) {
      reported = false;
    } else if (!reported) {
      reported = true;
      logged(house.deliver('/kit/idle', {}, idle));
    }
  };
  const conversations: Conversations = new Conversations({
    house,
    agents,
    copies,
    send: (frame) => stream?.send(frame) ?? false,
    changed,
  });
  const signIns: SignIns = new SignIns(house, agents, changed);
  const updates = new Updates(house);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      killDescendants();
      process.kill(process.pid, signal);
    });
  }

  await house.deliver('/kit/restarted', {}).catch(report);
  await updates.resumed().catch(report);
  logged(agents.refresh());
  stream = holdStream({
    opened: () => {
      conversations.opened();
      changed();
      logged(copies.select());
    },
    frame: (arrived: Frame) => {
      if (arrived.type === 'watching') conversations.watching(arrived.watching === true);
      if (arrived.type === 'work_available' && arrived.subject === 'agents') logged(agents.refresh());
      if (arrived.type === 'work_available' && arrived.subject === 'local_copy') logged(copies.select());
      if (arrived.type === 'entries') {
        copies.entries(arrived as unknown as { authority: string; position: string; log_epoch: string });
      }
      if (arrived.type === 'input') {
        reported = false;
        if (arrived.kind === 'sign_in') signIns.start(arrived as unknown as SignIn);
        else if (arrived.kind === 'update') updates.start(arrived as unknown as Update);
        else conversations.input(arrived as unknown as Input);
      }
    },
  });
}
