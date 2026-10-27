import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Agents } from './agents.ts';
import { house } from './api.ts';
import { received } from './bridge.ts';
import { CONVERSATION_METHODS, Conversations, type ConversationCall } from './conversations.ts';
import { LocalCopies, type Pushed } from './copies.ts';
import { restart, unknownMethod } from './end.ts';
import { agentBase, enrolled, forgetRestart, kitHome, ownerLock, ownerSocket, readEnrolment, restartAsked } from './home.ts';
import { Calls, type Call } from './calls.ts';
import { killDescendants } from './scope.ts';
import { removeInputs, Scripts } from './scripts.ts';
import { quoted } from './shell.ts';
import { SignIns } from './sign-in.ts';
import { placeSkillSet } from './skills.ts';
import { holdConnection, type Connection, type Notification } from './connection.ts';
import { KitUpdate } from './update.ts';
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

function claimed(lock: DatabaseSync): boolean {
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return true;
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 5) return false;
    throw error;
  }
}

async function serveOwner(copies: LocalCopies): Promise<void> {
  const lock = new DatabaseSync(ownerLock());
  if (!claimed(lock)) {
    lock.close();
    const running = await runningResident();
    throw new Error(
      `${running === null ? 'another Kit process' : `Kit process ${running}`} already runs this Environment from Kit home ${kitHome()}; stop it first to run another Kit process here`,
    );
  }
  const server = createServer(async (request, response) => {
    try {
      const text = await received(request);
      let answered: Pushed;
      if (request.url === '/resident') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pid: process.pid }));
        return;
      }
      if (request.url === '/git/fetch') {
        answered = await copies.fetch();
      } else if (request.url === '/git/push') {
        const { cwd, commit } = JSON.parse(text) as { cwd: string; commit: string };
        answered = await copies.push(cwd, commit, copies.owner);
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answered));
    } catch (error) {
      response.writeHead(502).end(error instanceof Error ? error.message : String(error));
    }
  });
  server.on('close', () => lock.close());
  await rm(ownerSocket(), { force: true });
  server.listen(ownerSocket());
  await once(server, 'listening');
}

function runningResident(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    get({ socketPath: ownerSocket(), path: '/resident' }, (answer) => {
      received(answer).then((text) => resolve((JSON.parse(text) as { pid: number }).pid), reject);
    }).on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(null);
      else reject(error);
    });
  });
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

async function started(): Promise<void> {
  await connected();
  await forgetRestart();
  watch(kitHome(), () => {
    if (enrolled()) return;
    killDescendants();
    process.exit(1);
  });
  await placeSkillSet((await readEnrolment())!.house);
  await mkdir(agentBase(), { recursive: true });
  await installShim(join(kitHome(), 'shim', 'git'), 'git-main');
  await installShim(codexLauncher(), 'codex-main');
}

export async function resident(): Promise<void> {
  await mkdir(kitHome(), { recursive: true, mode: 0o700 });
  const copies = new LocalCopies(house);
  await copies.load();
  await serveOwner(copies);
  await started().catch((error: unknown) => {
    report(error);
    process.exit(1);
  });
  process.env.HOUSE_KIT_RESIDENT = String(process.pid);
  const agents = new Agents(house, () => changed());
  let connection: Connection | null = null;
  let reported = false;
  const idle = () => calls.idle() && conversations.idle() && agents.idle();
  const changed = () => {
    if (!idle()) {
      reported = false;
    } else if (restartAsked() && conversations.quiet()) {
      restart('restarting for an updated CLI');
    } else if (update.held() && conversations.quiet()) {
      update.apply(connection!.pause());
    } else if (!reported) {
      reported = true;
      logged(house.deliver('/kit/idle', {}, idle));
    }
  };
  const calls = new Calls(house, changed);
  const conversations: Conversations = new Conversations({
    house,
    agents,
    copies,
    calls,
    send: (notification) => connection?.send(notification) ?? false,
    changed,
  });
  const signIns = new SignIns(house, agents, calls);
  const update = new KitUpdate(calls, changed);
  removeInputs();
  const scripts = new Scripts(calls, (notification) => connection?.send(notification) ?? false);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      killDescendants();
      removeInputs();
      process.kill(process.pid, signal);
    });
  }

  await house.deliver('/kit/restarted', {}).catch(report);
  await update.resumed().catch(report);
  logged(agents.refresh());
  connection = holdConnection({
    opened: () => {
      conversations.opened();
      changed();
      logged(copies.connected());
    },
    closed: () => scripts.disconnected(),
    call: (call: Call) => {
      if (call.kind === 'sign_in') signIns.start(call);
      else if (call.kind === 'update') update.hold(call);
      else if (call.kind === 'run_wizard' || call.kind === 'run_function') scripts.start(call);
      else if (CONVERSATION_METHODS.has(call.kind)) conversations.call(call as ConversationCall);
      else {
        const refused = { refused: unknownMethod((call as { kind: string }).kind) };
        void calls.carry(call.input_id, async () => ({ result: refused }));
      }
    },
    notification: (notification: Notification) => {
      if (notification.type === 'watching') conversations.watching(notification.watching === true);
      if (notification.type === 'authority_changed') logged(copies.changed(notification.rooms as string[]));
      if (notification.type === 'work_available' && notification.subject === 'agents') logged(agents.refresh());
      scripts.notified(notification);
    },
  });
}
