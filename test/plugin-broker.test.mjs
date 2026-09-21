import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ControlStore, ownerId, ownerEpoch } from '../src/control-state.js';
import { RunStore } from '../src/runs.js';
import { loadPluginBrokerBinding, servePluginBroker, validateBrokerRequest } from '../src/plugin-broker.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const revision = 'sha256:' + 'a'.repeat(64);

test('relay compose surface has no broker Docker socket or tools-home mount', async () => {
  const compose = await fs.readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const relay = compose.slice(0, compose.indexOf('  plugin-broker:'));
  assert.equal(relay.includes('/var/run/docker.sock'), false);
  assert.equal(relay.includes('EZ_TOOLS_HOME'), false);
  assert.equal(compose.slice(compose.indexOf('  plugin-broker:')).includes('/var/run/docker.sock'), true);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'e-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'tools');
  const workspace = path.join(root, 'mind');
  const controlDir = path.join(root, 'control');
  const hostConfig = path.join(root, 'host-executor.json');
  const socket = path.join(controlDir, 'plugin-broker.sock');
  const source = path.join(home, 'packages', 'sample', revision.slice(7));
  await Promise.all([home, workspace, controlDir, source].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  await fs.mkdir(path.join(root, 'bin'), { mode: 0o700 });
  const host = { cli: 'codex', isolation: 'isolated', agents: [{ name: 'tenant-a', toolsHome: home, workspace, controlDir, binDir: path.join(root, 'bin') }] };
  await fs.writeFile(hostConfig, JSON.stringify(host) + '\n', { mode: 0o600 });
  const realHost = await fs.realpath(hostConfig);
  const realHome = await fs.realpath(home);
  const realWorkspace = await fs.realpath(workspace);
  const realControl = await fs.realpath(controlDir);
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, workspace: realWorkspace, hostConfig: realHost }) + '\n', { mode: 0o600 });
  const record = {
    revision,
    source,
    project: `ezp-${hash(realHome).slice(0, 16)}-sample`,
    manifest: { schemaVersion: 1, id: 'sample', version: '1.0.0', commands: { sample: { executable: 'client.mjs', args: [] } }, skills: [] },
    deployment: { schemaVersion: 1, services: { sample: { buildTarget: 'runtime', volumes: {}, workspace: false, healthcheck: ['node', '--version'] } }, commands: { sample: { service: 'sample', argv: ['node', '/app/client.mjs'], suffix: [] } }, exports: {} },
    compose: path.join(home, 'packages', 'sample', 'compose.json'),
  };
  await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify({ schemaVersion: 1, owner: realHome, plugins: { sample: record }, commands: { sample: 'sample' } }) + '\n', { mode: 0o600 });
  const fake = path.join(root, 'fake');
  await fs.mkdir(fake, { mode: 0o700 });
  await fs.writeFile(path.join(fake, 'docker'), `#!${process.execPath}
const a=process.argv.slice(2);
if(a.includes('loud'))process.stdout.write('x'.repeat(1024*1024+1));
else if(a.includes('run'))process.stdout.write('broker-ok');
`, { mode: 0o700 });
  const control = new ControlStore(realControl, 1000);
  await control.requestPairing(42, 42);
  const owner = await control.approveOwner(42);
  const run = await new RunStore(realControl).create({ id: 'r_broker', chatId: 42, telegramUserId: 42, texts: ['broker test'], ownerId: ownerId(owner), ownerEpoch: ownerEpoch(owner) });
  await new RunStore(realControl).patch(run.id, { status: 'running' });
  return { root, home: realHome, workspace: realWorkspace, controlDir: realControl, hostConfig: realHost, socket, runId: run.id, fake };
}

async function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.on('connect', () => socket.end(JSON.stringify(payload) + '\n'));
  });
}

async function waitForSocket(socketPath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fs.stat(socketPath)).isSocket()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Broker socket did not start');
}

test('isolated broker authenticates an owned run, pins plugin revision, and writes receipts', async t => {
  const f = await fixture(t);
  const binding = await loadPluginBrokerBinding({ home: f.home, workspace: f.workspace, controlDir: f.controlDir, socket: f.socket, hostConfig: f.hostConfig, timeoutMs: 10_000 });
  const previousPath = process.env.PATH;
  process.env.PATH = f.fake + path.delimiter + previousPath;
  const abort = new AbortController();
  const serving = servePluginBroker(binding, abort.signal);
  try {
    await waitForSocket(f.socket);
    const published = JSON.parse(await fs.readFile(path.join(f.controlDir, 'plugin-broker-plugins.json'), 'utf8'));
    assert.deepEqual(published.plugins, [{ id: 'sample', version: '1.0.0' }]);
    const listed = await request(f.socket, { version: 1, id: randomUUID(), operation: 'manager', runId: f.runId, args: ['tools', 'list'] });
    assert.equal(listed.ok, true);
    assert.deepEqual(JSON.parse(listed.stdout), { sample: 'sample' });
    const detailed = await request(f.socket, { version: 1, id: randomUUID(), operation: 'manager', runId: f.runId, args: ['tools', 'list', '--details'] });
    assert.equal(detailed.ok, true);
    assert.deepEqual(JSON.parse(detailed.stdout).sample.commands, ['ez sample --help']);
    const resolved = await request(f.socket, { version: 1, id: randomUUID(), operation: 'resolve', runId: f.runId, alias: 'sample' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.revision, revision);
    const invoked = await request(f.socket, { version: 1, id: randomUUID(), operation: 'invoke', runId: f.runId, alias: 'sample', revision, capability: resolved.capability, args: ['literal', '$(not-a-shell)'], stdin: 'input' });
    assert.equal(invoked.ok, true);
    assert.equal(invoked.stdout, 'broker-ok');
    assert.equal(invoked.receipt.status, 'completed');
    assert.deepEqual(JSON.parse(await fs.readFile(invoked.receiptPath, 'utf8')), invoked.receipt);
    const replay = await request(f.socket, { version: 1, id: randomUUID(), operation: 'invoke', runId: f.runId, alias: 'sample', revision, capability: resolved.capability, args: [] });
    assert.equal(replay.ok, false);
    assert.match(replay.error, /capability/);
    const loudResolved = await request(f.socket, { version: 1, id: randomUUID(), operation: 'resolve', runId: f.runId, alias: 'sample' });
    const loud = await request(f.socket, { version: 1, id: randomUUID(), operation: 'invoke', runId: f.runId, alias: 'sample', revision, capability: loudResolved.capability, args: ['loud'] });
    assert.equal(loud.ok, false);
    assert.match(loud.error, /output limit/);
    assert.equal(loud.receipt.status, 'failed');
    const generated = JSON.parse(await fs.readFile(f.home + '/packages/sample/compose.json', 'utf8'));
    assert.equal(generated.version, '3.8');
  } finally {
    abort.abort();
    await serving;
    process.env.PATH = previousPath;
  }
});

test('broker rejects foreign agent bindings and unsafe management or request fields', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'foreign');
  const foreignHome = path.join(foreign, 'tools');
  const foreignWorkspace = path.join(foreign, 'mind');
  const foreignControl = path.join(foreign, 'control');
  await Promise.all([foreignHome, foreignWorkspace, foreignControl].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  await fs.writeFile(path.join(foreignHome, 'config.json'), JSON.stringify({ schemaVersion: 1, workspace: await fs.realpath(foreignWorkspace), hostConfig: f.hostConfig }));
  await fs.writeFile(path.join(foreignHome, 'registry.json'), JSON.stringify({ schemaVersion: 1, owner: await fs.realpath(foreignHome), plugins: {}, commands: {} }));
  await assert.rejects(loadPluginBrokerBinding({ home: foreignHome, workspace: foreignWorkspace, controlDir: foreignControl, socket: path.join(foreignControl, 'plugin-broker.sock'), hostConfig: f.hostConfig }), /owned by exactly one isolated agent/);
  await assert.rejects(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['plugins', 'install', 'sample', '--source', '/tmp/plugin'] }), /not allowed/);
  await assert.doesNotReject(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['plugins', 'uninstall', 'sample'] }, f.workspace));
  const source = path.join(f.workspace, 'plugin-source');
  await fs.mkdir(source);
  await assert.doesNotReject(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['plugins', 'catalog-add', 'sample', '--source', source, '--revision', revision] }, f.workspace));
  await assert.rejects(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['plugins', 'catalog-add', 'sample', '--source', '/tmp/plugin', '--revision', revision] }, f.workspace), /agent workspace/);
  const candidate = path.join(source, 'candidate.tgz');
  await fs.writeFile(candidate, 'candidate');
  await assert.doesNotReject(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['updates', 'prepare', 'sample', '--file', candidate] }, f.workspace));
  await assert.rejects(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['updates', 'prepare', 'sample', '--file', '/tmp/candidate.tgz'] }, f.workspace), /agent workspace/);
  await assert.rejects(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'manager', runId: 'r_broker', args: ['updates', 'prepare', 'sample', '--version', '1.0.1'] }, f.workspace), /not allowed/);
  await assert.rejects(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'invoke', runId: 'r_broker', alias: 'sample', revision, capability: 'short', args: [] }), /capability/);
  await assert.rejects(validateBrokerRequest({ version: 1, id: randomUUID(), operation: 'invoke', runId: 'r_broker', alias: 'sample', revision, capability: 'a'.repeat(48), args: [], stdin: 'x'.repeat(1024 * 1024 + 1) }), /stdin/);
});

test('broker rejects resolve and invoke for a revoked run', async t => {
  const f = await fixture(t);
  const binding = await loadPluginBrokerBinding({ home: f.home, workspace: f.workspace, controlDir: f.controlDir, socket: f.socket, hostConfig: f.hostConfig, timeoutMs: 10_000 });
  const abort = new AbortController();
  const serving = servePluginBroker(binding, abort.signal);
  try {
    await waitForSocket(f.socket);
    await new RunStore(f.controlDir).patch(f.runId, { status: 'cancelled' });
    const resolved = await request(f.socket, { version: 1, id: randomUUID(), operation: 'resolve', runId: f.runId, alias: 'sample' });
    assert.equal(resolved.ok, false);
    const invoked = await request(f.socket, { version: 1, id: randomUUID(), operation: 'invoke', runId: f.runId, alias: 'sample', revision, capability: 'a'.repeat(64), args: [] });
    assert.equal(invoked.ok, false);
  } finally {
    abort.abort();
    await serving;
  }
});
