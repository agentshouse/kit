import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killDescendants } from './acp.ts';
import { Agents } from './agents.ts';
import { house } from './api.ts';
import { received } from './bridge.ts';
import { Conversations, type Input } from './conversations.ts';
import { WorkingCopies } from './copies.ts';
import { agentBase, kitHome, readEnrolment } from './home.ts';
import { SignIns, type SignIn } from './sign-in.ts';
import { placeSkillSet } from './skills.ts';
import { holdStream, type Frame, type Stream } from './stream.ts';
import { Updates, type Update } from './update.ts';

function report(error: unknown): void {
  process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
}

function logged(work: Promise<unknown>): void {
  work.catch(report);
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function installShim(): Promise<void> {
  const main = fileURLToPath(new URL(`./git-main${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  await mkdir(join(kitHome(), 'shim'), { recursive: true });
  await writeFile(join(kitHome(), 'shim', 'git'), `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(main)} "$@"\n`, {
    mode: 0o755,
  });
}

async function serveOwner(copies: WorkingCopies): Promise<void> {
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

export async function resident(): Promise<void> {
  if ((await readEnrolment()) === null) {
    process.stderr.write('kit: this Environment is not enrolled; run kit login\n');
    process.exitCode = 1;
    return;
  }
  await placeSkillSet();
  await mkdir(agentBase(), { recursive: true });
  process.env.HOUSE_KIT_RESIDENT = String(process.pid);
  const agents = new Agents(house);
  const copies = new WorkingCopies(house);
  await copies.load();
  await installShim();
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
      if (arrived.type === 'work_available' && arrived.subject === 'agents') logged(agents.refresh());
      if (arrived.type === 'work_available' && arrived.subject === 'working_copy') logged(copies.select());
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
