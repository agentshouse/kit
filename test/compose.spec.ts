import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { temporaryHome } from './kit.ts';

const run = promisify(execFile);
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'dependencies'];
const MARK = "node -e \"require('fs').writeFileSync(require('path').join(process.env.MARKS, process.env.npm_package_name + '-' + process.env.npm_lifecycle_event), '')\"";

it("installs the test container's locked dependencies without running a lifecycle script of the Kit or a package", async () => {
  const work = await temporaryHome();
  const marks = join(work, 'marks');
  const dependency = join(work, 'lifecycle');
  const project = join(work, 'project');
  await Promise.all([marks, dependency, project].map((directory) => mkdir(directory)));
  const env = { ...process.env, MARKS: marks, npm_config_cache: join(work, 'cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false' };
  const scripts = Object.fromEntries(LIFECYCLE.map((event) => [event, MARK]));
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'lifecycle', version: '1.0.0', scripts }));
  await run('npm', ['pack', '--ignore-scripts', '--pack-destination', work], { cwd: dependency, env });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'project', version: '1.0.0', private: true, scripts, dependencies: { lifecycle: 'file:../lifecycle-1.0.0.tgz' } }));
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: project, env });
  const { services } = parse(await readFile(new URL('../compose.yaml', import.meta.url), 'utf8'));
  const [shell, flag, script, name] = services.test.entrypoint as string[];

  await run(shell!, [flag!, script!.replaceAll('$$', '$'), name!, 'true'], { cwd: project, env });

  expect(await readdir(join(project, 'node_modules', 'lifecycle'))).toContain('package.json');
  expect(await readdir(marks)).toEqual([]);
});
