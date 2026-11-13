import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Agents } from './agents.ts';
import { house } from './api.ts';
import { received } from './bridge.ts';
import { Conversations } from './conversations.ts';
import { LocalCopies, type Pushed } from './copies.ts';
import { restart } from './end.ts';
import { agentBase, enrolled, kitHome, ownerSocket, readEnrolment } from './home.ts';
import { Calls } from './calls.ts';
import { KIT_RELEASE } from './clis.ts';
import { moveEarlier } from './earlier.ts';
import { holdOwner } from './owner.ts';
import { killDescendants } from './scope.ts';
import { removeInputs, Scripts } from './scripts.ts';
import { applySettings, enrolledRoutes, resumeWorkspaceMove, type Applied, type SettingsChange } from './settings.ts';
import { quoted } from './shell.ts';
import { SignIns } from './sign-in.ts';
import { placeSkillSet } from './skills.ts';
import { holdConnection, type Connection } from './connection.ts';
import { KitUpdate } from './update.ts';
import { takeUnservedRelease } from './wire.ts';
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

interface Settling {
  settle(change: SettingsChange, carried?: string): Promise<Applied>;
  answered(applied: Applied): void;
}

async function serveOwner(lock: DatabaseSync, copies: LocalCopies, settling: Settling): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const text = await received(request);
      let answered: Pushed | Applied;
      if (request.url === '/resident') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pid: process.pid, release: KIT_RELEASE }));
        return;
      }
      if (request.url === '/git/fetch') {
        answered = await copies.fetch();
      } else if (request.url === '/git/push') {
        const { cwd, commit } = JSON.parse(text) as { cwd: string; commit: string };
        answered = await copies.push(cwd, commit, copies.owner);
      } else if (request.url === '/settings') {
        const applied = await settling.settle(JSON.parse(text) as SettingsChange);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(applied), () => settling.answered(applied));
        return;
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
  await placeSkillSet((await readEnrolment())!.house);
  await mkdir(agentBase(), { recursive: true });
  await installShim(join(kitHome(), 'shim', 'git'), 'git-main');
  await installShim(codexLauncher(), 'codex-main');
}

export async function resident(): Promise<void> {
  await moveEarlier();
  await mkdir(kitHome(), { recursive: true, mode: 0o700 });
  const lock = await holdOwner();
  await resumeWorkspaceMove();
  const copies = new LocalCopies(house);
  await copies.load();
  let running: { conversations: Conversations; agents: Agents; calls: Calls; stop(then: () => void): Promise<void> } | null = null;
  let settings: Promise<unknown> = Promise.resolve();
  const settle = (change: SettingsChange, carried?: string): Promise<Applied> => {
    const applied = settings.then(() =>
      applySettings(change, {
        working: () => running !== null && (running.conversations.turnOpen() || running.calls.busy(carried)),
        end: () => {
          running?.conversations.stopped();
          killDescendants();
        },
        routes: async () => {
          if (running === null) return enrolledRoutes();
          await running.agents.read();
          return running.agents.desired.routes;
        },
      }),
    );
    settings = applied.catch(() => undefined);
    return applied.then((answer) => {
      if ('settings' in answer && !answer.moved) running?.agents.report().catch(report);
      return answer;
    });
  };
  const answered = (applied: Applied) => {
    if ('settings' in applied ? !applied.moved : !applied.ended) return;
    const ended =
      'settings' in applied
        ? `the workspace moved to ${applied.settings.workspace}; its supervisor starts Kit there`
        : 'the workspace stays where it was; its supervisor starts Kit again';
    if (running === null) restart(ended);
    else void running.stop(() => restart(ended));
  };
  await serveOwner(lock, copies, { settle, answered });
  await copies.swept();
  await started().catch((error: unknown) => {
    report(error);
    process.exit(1);
  });
  process.env.HOUSE_KIT_RESIDENT = String(process.pid);
  const agents = new Agents(house, () => changed());
  let connection: Connection | null = null;
  let reported = false;
  let stopping = false;
  const stop = async (then: () => void): Promise<void> => {
    if (stopping) return;
    stopping = true;
    conversations.stopped();
    killDescendants();
    await connection?.close();
    then();
  };
  const idle = () => calls.idle() && conversations.idle() && agents.idle();
  const changed = () => {
    if (!idle()) {
      reported = false;
    } else if (update.placedRelease() !== null && conversations.quiet() && process.env.HOUSE_KIT_SANDBOX !== '1') {
      const placed = update.placedRelease();
      void stop(() => restart(`Kit ${placed} is placed; its supervisor starts it`));
    } else if (!reported) {
      reported = true;
      logged(house.deliver('kits/report-idle', {}, idle));
    }
  };
  const calls = new Calls(house, changed);
  const conversations: Conversations = new Conversations({
    house,
    agents,
    copies,
    calls,
    send: (oneWayCall) => connection?.send(oneWayCall) ?? false,
    changed,
  });
  const signIns = new SignIns(house, agents, calls);
  const update = new KitUpdate(calls);
  takeUnservedRelease((release) => logged(update.takeRefused(release)));
  removeInputs();
  const scripts = new Scripts(calls, (oneWayCall) => connection?.send(oneWayCall) ?? false);
  running = { conversations, agents, calls, stop };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void stop(() => {
        removeInputs();
        process.kill(process.pid, signal);
      });
    });
  }
  const unenrolled = () => {
    if (!enrolled()) void stop(() => process.exit(1));
  };
  watch(kitHome(), unenrolled);
  unenrolled();

  await house.deliver('kits/report-restart', {}).catch(report);
  logged(agents.refresh());
  agents.keepCurrent(() => process.env.HOUSE_KIT_SANDBOX === '1' && reported);
  connection = holdConnection({
    opened: () => {
      conversations.opened();
      scripts.connected();
      changed();
      logged(copies.connected());
    },
    closed: () => scripts.disconnected(),
    call: (call) => {
      if (call.kind === 'sign_in') signIns.start(call);
      else if (call.kind === 'update') update.take(call);
      else if (call.kind === 'settings') {
        void calls.carry(call.input_id, async () => {
          const applied = await settle(call, call.input_id);
          const result = 'refused' in applied ? { refused: applied.refused } : { settings: applied.settings };
          if ('settings' in applied ? !applied.moved : !applied.ended) return { result };
          calls.keepResult(call.input_id, result);
          return new Promise<never>(() => answered(applied));
        });
      }
      else if (call.kind === 'run_wizard' || call.kind === 'run_function') scripts.start(call);
      else conversations.call(call);
    },
    oneWayCall: (oneWayCall) => {
      if (oneWayCall.type === 'watching') conversations.watching(oneWayCall.watching);
      if (oneWayCall.type === 'work_available' && oneWayCall.subject === 'agents') logged(agents.refresh());
      scripts.notified(oneWayCall);
    },
  });
}
