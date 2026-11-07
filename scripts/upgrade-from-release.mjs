// Upgrade a throwaway agent from the published release to this checkout with
// the published release's own updater. That updater, not this branch's, gates
// and prepares real upgrades, so this is the only test of that boundary.
// It runs eligibility and every preparation step up to the image build, then
// stops: no Docker, nothing started or stopped. Usage: pnpm upgrade:check [spec]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newer } from '../src/updates/artifact.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const name = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).name;
const spec = process.argv[2] || `${name}@latest`;
const work = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'ez-upgrade-')));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, value, mode = 0o600) => fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
async function pack(source, dest) {
  const [{ filename }] = JSON.parse(run('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', work], repo));
  const box = await fs.mkdtemp(path.join(work, 'x-'));
  run('tar', ['-xzf', path.join(work, filename), '-C', box]);
  await fs.rename(path.join(box, 'package'), dest);
  return path.join(work, filename);
}

try {
  // Installed side: the published package with its own dependencies.
  const old = path.join(work, 'old');
  await pack(spec, old);
  await fs.copyFile(path.join(old, 'docker/pnpm-lock.yaml'), path.join(old, 'pnpm-lock.yaml'));
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--silent'], old);
  const from = (await read(path.join(old, 'package.json'))).version;

  // Candidate: this checkout as npm packs it. Between releases it carries the
  // published version, so number it one beta ahead, as its release will be.
  const candidate = path.join(work, 'candidate');
  let tarball = await pack(repo, candidate);
  const pkg = await read(path.join(candidate, 'package.json'));
  if (!newer(pkg.version, from)) {
    const beta = /^(.*-beta\.)(\d+)$/.exec(from);
    if (!beta) throw Error(`Cannot number a candidate after ${from}`);
    pkg.version = `${beta[1]}${Number(beta[2]) + 1}`;
    await write(path.join(candidate, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 0o644);
    tarball = await pack(candidate, path.join(work, 'renumbered'));
  }

  // A minimal bound deployment, as `ez` setup leaves it for one agent.
  const deployment = path.join(work, 'agent'), home = path.join(deployment, 'tools');
  const agent = { name: 'agent', workspace: path.join(deployment, 'mind'), controlDir: path.join(deployment, 'control'), binDir: path.join(home, 'bin'), toolsHome: home };
  for (const dir of [agent.binDir, path.join(home, 'updates'), agent.workspace, agent.controlDir]) await fs.mkdir(dir, { recursive: true });
  await write(path.join(deployment, 'host-executor.json'), { cli: 'codex', agents: [agent] });
  await write(path.join(home, 'config.json'), { schemaVersion: 1, workspace: agent.workspace, catalog: {}, deploymentDir: deployment, packageRoot: old });
  await write(path.join(home, 'registry.json'), { schemaVersion: 1, owner: home, plugins: {}, commands: {} });
  for (const file of ['agent.json', 'purpose.md']) await write(path.join(deployment, file), '{}');
  await write(path.join(deployment, 'relay.env'), 'TELEGRAM_BOT_TOKEN=upgrade-check-placeholder\n');
  await write(path.join(deployment, 'docker.env'), `COMPOSE_FILE='${old}/compose.yaml'\nCOMPOSE_PROJECT_NAME='ez-upgrade-check'\n`);
  await write(path.join(agent.workspace, 'AGENTS.md'), '# Purpose\n\nUpgrade check.\n', 0o660);

  // Control state written by the installed release, which the candidate must read.
  const load = file => import(pathToFileURL(path.join(old, file)).href);
  const { ControlStore } = await load('src/control-state.ts'), { initialPreset } = await load('src/ai.ts');
  const store = new ControlStore(agent.controlDir, 60000);
  await store.captureChoice(initialPreset('codex'));
  await store.ensureActiveSession();

  const control = await load('src/updates/control.mjs'), runtime = await load('src/updates/runtime.mjs');
  const prepared = await control.prepare(home, 'main', { file: tarball });
  await write(path.join(home, 'updates/supervisor.json'), { at: Date.now() });
  const job = await control.submit(home, prepared.id, false);

  const stop = 'upgrade check: stopped before the image build', host = [];
  let stoppedAt;
  const execute = async (command, args, options) => {
    if (command === 'docker') {
      if (args.includes('config')) return JSON.stringify({ services: { relay: { build: { args: {} } } } });
      stoppedAt = `docker ${args[0]}`;
      throw Error(stop);
    }
    if (args.includes('view') && args.some(arg => arg.startsWith('@openai/codex'))) return JSON.stringify('0.0.0');
    return runtime.execute(command, args, options);
  };
  const result = await runtime.perform(home, job, {
    execute,
    stopHost: async () => host.push('stopHost'),
    startHost: async () => host.push('startHost'),
  });
  if (result.error !== stop || stoppedAt !== 'docker build' || host.length)
    throw Error(`Published ${from} updater did not prepare ${pkg.version}: ${result.status}: ${result.error}${host.length ? ` (host: ${host.join(', ')})` : ''}`);
  console.log(`Upgrade check passed: the published ${from} updater admits and prepares this checkout as ${pkg.version} up to the image build.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (!process.env.EZ_KEEP_UPGRADE_CHECK) await fs.rm(work, { recursive: true, force: true });
  else console.error(`Kept ${work}`);
}
