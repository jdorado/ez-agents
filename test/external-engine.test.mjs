import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openExternalEnvironment } from '../src/external-engine.mjs';
import { serveExternalEngine } from '../src/external-engine-mcp.mjs';
import { workspaceLease } from '../src/plugins/workspace-lease.mjs';
import { validate } from '../src/plugins/manager.mjs';

const revision = 'sha256:' + 'a'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, tools = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'ez-external-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'tools'), workspace = path.join(root, 'mind');
  const source = path.join(home, 'packages', 'sample', revision.slice(7));
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Use approved tools. Café.');
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, workspace }));
  const record = { revision, source, project: `ezp-${hash(home).slice(0, 16)}-sample`,
    manifest: { schemaVersion: 1, id: 'sample', version: '1.0.0', skills: [], commands: {
      sample: { executable: 'client.mjs', args: ['doctor'], externalRead: true,
        exposure: { changesRecords: false, requiresReview: false, sendsExternally: false } } } },
    deployment: { schemaVersion: 1, services: { sample: { buildTarget: 'runtime', volumes: {}, workspace: false,
      healthcheck: ['node', '--version'] } }, commands: { sample: { service: 'sample', argv: ['node', '/app/client.mjs'], suffix: ['doctor'] } }, exports: {} },
    compose: path.join(home, 'packages', 'sample', 'compose.json') };
  const registry = { schemaVersion: 1, owner: home, plugins: { sample: record }, commands: { sample: 'sample' } };
  await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify(registry));
  const grant = { schemaVersion: 1, id: 'sample-env', toolsHome: home, workspace,
    contextPaths: ['AGENTS.md'], tools: tools ? [{ name: 'health', command: 'sample', revision, description: 'Sanitized health.' }] : [] };
  const file = path.join(root, 'grant.json');
  await fs.writeFile(file, JSON.stringify(grant), { mode: 0o600 });
  return { root, home, workspace, file, grant, registry, record,
    saveGrant: () => fs.writeFile(file, JSON.stringify(grant)),
    saveRegistry: () => fs.writeFile(path.join(home, 'registry.json'), JSON.stringify(registry)) };
}

async function rpc(engine, requests, split = false) {
  const text = requests.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';
  let out = '';
  const bytes = Buffer.from(text);
  const chunks = split ? Array.from(bytes, byte => Buffer.from([byte])) : [bytes];
  await serveExternalEngine(Readable.from(chunks), new Writable({ write(chunk, _, done) { out += chunk.toString(); done(); } }), engine);
  return out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const init = [ { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' } ];
const call = (name, args = {}, id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('empty grants bootstrap only, scoped context and receipts without model state', async t => {
  const f = await fixture(t, false), engine = await openExternalEnvironment(f.file);
  assert.deepEqual((await engine.listTools()).map(tool => tool.name), ['environment_bootstrap']);
  const { data, receipt } = await engine.callTool('environment_bootstrap');
  assert.equal(data.environment, 'sample-env');
  assert.deepEqual(data.context, [{ path: 'AGENTS.md', text: 'Use approved tools. Café.', sha256: hash('Use approved tools. Café.') }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.environment, 'sample-env');
  assert.equal(JSON.stringify(data).includes(f.root), false);
  await assert.rejects(engine.callTool('health'), /UNKNOWN_TOOL/);
  await assert.rejects(engine.callTool('environment_bootstrap', { path: '/etc/passwd' }), /INVALID_ARGUMENTS/);
  await assert.rejects(engine.callTool('environment_bootstrap', null), /INVALID_ARGUMENTS/);
});

test('literal read alias uses existing plugin broker, no ambient native authority', async t => {
  const f = await fixture(t), fake = path.join(f.root, 'fake');
  await fs.mkdir(fake);
  await fs.writeFile(path.join(fake, 'docker'), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('run')){if(!a.includes('doctor')||process.env.TELEGRAM_BOT_TOKEN||process.env.EZ_RUN_ID)process.exit(9);process.stdout.write(JSON.stringify({status:'ok'}));}\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, EZ_RUN_ID: process.env.EZ_RUN_ID };
  process.env.PATH = fake + path.delimiter + process.env.PATH;
  process.env.TELEGRAM_BOT_TOKEN = 'fixture-secret'; process.env.EZ_RUN_ID = 'foreign-run';
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const engine = await openExternalEnvironment(f.file);
  const result = await engine.callTool('health');
  assert.deepEqual(result.data, { status: 'ok' });
  assert.equal(result.receipt.pluginRevision, revision);
  await assert.rejects(engine.callTool('health', { args: ['trade'] }), /INVALID_ARGUMENTS/);
  const compose = JSON.parse(await fs.readFile(f.record.compose, 'utf8'));
  assert.equal(JSON.stringify(compose).includes('foreign-run'), false);
  await assert.rejects(fs.stat(path.join(f.home, 'workspace-writer.lock')), { code: 'ENOENT' });
});

test('grants fail closed for mismatched scope, permissions, extra fields and unsafe context paths', async t => {
  for (const change of [g => { delete g.id; }, g => { g.toolsHome = g.workspace; }, g => { g.shell = true; },
    g => { g.contextPaths = ['../outside.md']; }, g => { g.contextPaths = ['.env.md']; },
    g => { g.tools[0].arguments = ['write']; }, g => { delete g.tools[0].name; }]) {
    const f = await fixture(t); change(f.grant); await f.saveGrant();
    await assert.rejects(openExternalEnvironment(f.file), /INVALID_BINDING/);
  }
  const f = await fixture(t);
  await fs.chmod(f.file, 0o666);
  await assert.rejects(openExternalEnvironment(f.file), /INVALID_BINDING/);
});

test('revoked grants/config, unknown aliases, revision mismatch and unsafe manifests are unavailable', async t => {
  const f = await fixture(t), engine = await openExternalEnvironment(f.file);
  f.grant.contextPaths = []; await f.saveGrant();
  await assert.rejects(engine.listTools(), /BINDING_CHANGED/);
  const g = await fixture(t), bound = await openExternalEnvironment(g.file);
  await fs.writeFile(path.join(g.home, 'config.json'), JSON.stringify({ schemaVersion: 1, workspace: g.workspace, hostConfig: '/different' }));
  await assert.rejects(bound.callTool('environment_bootstrap'), /BINDING_CHANGED/);
  for (const change of [r => { r.revision = 'sha256:' + 'b'.repeat(64); },
    r => { delete r.manifest.commands.sample.externalRead; }, r => { r.manifest.commands.sample.exposure.changesRecords = true; },
    r => { r.manifest.commands.sample.exposure.requiresReview = true; }]) {
    const h = await fixture(t), e = await openExternalEnvironment(h.file);
    change(h.record); await h.saveRegistry();
    await assert.rejects(e.listTools(), /TOOL_UNAVAILABLE/);
    await assert.rejects(e.callTool('health'), /TOOL_UNAVAILABLE/);
  }
});

test('package validation requires an explicit safe externalRead declaration', async t => {
  const f = await fixture(t), files = new Map([['client.mjs', {}]]);
  assert.doesNotThrow(() => validate(f.record.manifest, f.record.deployment, files));
  for (const value of [false, 'true', true]) {
    const manifest = structuredClone(f.record.manifest);
    manifest.commands.sample.externalRead = value;
    if (value === true) delete manifest.commands.sample.exposure.requiresReview;
    assert.throws(() => validate(manifest, f.record.deployment, files), /externalRead/);
  }
});

test('context denies symlinks, credentials, oversized data and busy workspace; always releases lease', async t => {
  for (const kind of ['symlink', 'secret', 'large']) {
    const f = await fixture(t, false), engine = await openExternalEnvironment(f.file);
    const file = path.join(f.workspace, 'AGENTS.md');
    if (kind === 'symlink') { await fs.unlink(file); await fs.symlink(f.file, file); }
    else await fs.writeFile(file, kind === 'large' ? 'x'.repeat(32769) : 'token=fixturecredential123456789012345');
    await assert.rejects(engine.callTool('environment_bootstrap'), /CONTEXT_UNAVAILABLE/);
    await assert.rejects(fs.stat(path.join(f.home, 'workspace-writer.lock')), { code: 'ENOENT' });
  }
  const f = await fixture(t), engine = await openExternalEnvironment(f.file), release = await workspaceLease(f.home, { kind: 'native' });
  try { await assert.rejects(engine.callTool('environment_bootstrap'), /busy/); await assert.rejects(engine.callTool('health'), /busy/); }
  finally { await release(); }
});

test('MCP initialization, discovery and tool errors are bounded and sanitized', async t => {
  const f = await fixture(t, false), engine = await openExternalEnvironment(f.file);
  const results = await rpc(engine, [...init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, call('environment_bootstrap'),
    call('run_agent', {}, 4), call('environment_bootstrap', null, 5),
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: '/etc/passwd' } },
    { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: 'anything' } }], true);
  assert.equal(results[0].result.protocolVersion, '2025-03-26');
  assert.equal(results[1].result.tools.length, 1);
  assert.match(results[2].result.content[0].text, /Café/);
  assert.equal(results[3].result.isError, true);
  assert.equal(results[3].result.content[0].text, 'UNKNOWN_TOOL');
  assert.equal(results[4].result.content[0].text, 'INVALID_ARGUMENTS');
  assert.equal(results[5].error.message, 'UNSUPPORTED_METHOD');
  assert.equal(results[6].error.message, 'INVALID_ARGUMENTS');
  assert.equal(JSON.stringify(results).includes(f.root), false);
  const before = await rpc(engine, [call('environment_bootstrap')]);
  assert.equal(before[0].error.message, 'NOT_INITIALIZED');
  const failure = await rpc({ callTool() { throw Error('secret/path'); } }, [...init, call('health')]);
  assert.equal(failure[1].result.content[0].text, 'EXTERNAL_READ_FAILED');
  const malformed = await rpc(engine, ['{', '[]', 'x'.repeat(65537)]);
  assert.equal(malformed.every(result => result.error.message === 'INVALID_REQUEST'), true);
});

test('packaged CLI help and missing policy need no credentials or model', async () => {
  const run = promisify(execFile), bin = path.resolve('bin/ezenciel-agents-external-engine.mjs');
  const help = await run(process.execPath, [bin, '--help']);
  assert.match(help.stdout, /Read-only stdio MCP/);
  await assert.rejects(run(process.execPath, [bin, '--binding', '/missing/private/policy.json']), error => {
    assert.equal(error.stdout, ''); assert.equal(error.stderr.trim(), 'EXTERNAL_ENGINE_UNAVAILABLE'); return true;
  });
});

async function smokeFixture(t) {
  const f = await fixture(t, false);
  const library = structuredClone(f.record);
  library.manifest.id = 'library';
  library.manifest.commands = { library: { executable: 'bin/ez-library.mjs', args: [], exposure: {
    receivesExternalContent: true, sendsExternally: true, changesRecords: true, requiresReview: true } } };
  library.deployment.commands = { library: { service: 'sample', argv: ['node', '/app/bin/ez-library.mjs'] } };
  library.project = `ezp-${hash(f.home).slice(0,16)}-library`;
  library.compose = path.join(f.home, 'packages', 'library', 'compose.json');
  library.source = path.join(f.home, 'packages', 'library', revision.slice(7));
  await fs.mkdir(library.source, { recursive: true });
  f.registry.commands.library = 'library'; f.registry.plugins.library = library;
  await f.saveRegistry();
  f.grant.smokeNote = { revision, library: 'default' }; await f.saveGrant();
  const fake = path.join(f.root, 'fake'); await fs.mkdir(fake);
  const state = path.join(f.root, 'provider.json'), trace = path.join(f.root, 'argv.jsonl');
  await fs.writeFile(path.join(fake, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
const args=process.argv.slice(2);if(!args.includes('run'))process.exit(0);
const cli=args.slice(args.indexOf('/app/bin/ez-library.mjs')+1);
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(cli)+'\\n');
if(process.env.EZ_RUN_ID||process.env.TELEGRAM_BOT_TOKEN)process.exit(9);
const opts=Object.fromEntries(cli.slice(1).filter((_,i)=>i%2===0).map((k,i)=>[k,cli[2+i*2]]));
const file=${JSON.stringify(state)},input=fs.readFileSync(0,'utf8');
let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
if(fs.existsSync(${JSON.stringify(path.join(f.root, 'reject'))}))process.exit(4);
const emit=data=>process.stdout.write(JSON.stringify({ok:true,data}));
if(opts['--library']!=='default')process.exit(8);
if(cli[0]==='put'){
 if(opts['--path']!=='notes/ez-external-smoke/sample-env.md'||opts['--expected']!=='new')process.exit(8);
 const sha256=crypto.createHash('sha256').update(input).digest('hex');
 if(state&&(state.key!==opts['--key']||state.sha256!==sha256))process.exit(3);
 const replay=!!state;state={kind:'file',path:opts['--path'],expected:'new',key:opts['--key'],sha256,bytes:Buffer.byteLength(input),text:input,state:'stored'};
 fs.writeFileSync(file,JSON.stringify(state));emit({...state,replay});
}else if(cli[0]==='operation'){
 if(!state||state.key!==opts['--key'])process.exit(4);emit(state);
}else if(cli[0]==='get'){
 if(!state||state.path!==opts['--path']||!cli.includes('--raw'))process.exit(4);process.stdout.write(state.text);
}else process.exit(8);
`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = fake + path.delimiter + previous;
  t.after(() => { process.env.PATH = previous; });
  return { ...f, library, state, trace, engine: await openExternalEnvironment(f.file) };
}
const smokeId = 'dba332d4-d8a1-477e-bcb9-69894f28111f';
test('explicit smoke grant writes one new Library note, reads durable receipt/bytes and rejects overwrite', async t => {
  const f = await smokeFixture(t);
  const listed = await f.engine.listTools();
  assert.deepEqual(listed.map(tool => tool.name), ['environment_bootstrap','smoke_note_write','smoke_note_read']);
  assert.equal(listed[1].annotations.readOnlyHint, false);
  const input = { requestId: smokeId, text: 'External environment persistence smoke. Café.' };
  const write = await f.engine.callTool('smoke_note_write', input);
  assert.equal(write.data.state, 'stored'); assert.equal(write.data.replay, false);
  assert.equal(write.receipt.pluginRevision, revision);
  const replay = await f.engine.callTool('smoke_note_write', input);
  assert.equal(replay.data.replay, true);
  const restarted = await openExternalEnvironment(f.file);
  const read = await restarted.callTool('smoke_note_read', { requestId: smokeId });
  assert.equal(read.data.text, input.text); assert.equal(read.data.sha256, write.data.sha256);
  assert.equal(read.data.path, 'notes/ez-external-smoke/sample-env.md');
  await assert.rejects(restarted.callTool('smoke_note_write', { ...input, text: 'replacement' }), /failed or uncertain/);
  await assert.rejects(restarted.callTool('smoke_note_write', { ...input, requestId: 'affffddd-d8a1-477e-bcb9-69894f28111f' }), /failed or uncertain/);
  const vectors = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(vectors.every(args => ['put','get','operation'].includes(args[0])), true);
  assert.equal(vectors.filter(args => args[0] === 'put').every(args => args.includes('new')), true);
  assert.equal(vectors.some(args => args.includes('/etc/passwd')), false);
});

test('smoke authority rejects forged paths, broad commands, malformed input, stale pins and changed readback', async t => {
  const f = await smokeFixture(t);
  for (const input of [ { requestId: smokeId, text: 'ok', path: '../profile.md' }, { requestId: smokeId, text: 'ok', args: ['remove'] },
    { requestId: '../other', text: 'ok' }, { requestId: smokeId, text: 'é'.repeat(513) }, { requestId: smokeId, text: '\0' },
    { requestId: smokeId, text: '' } ]) await assert.rejects(f.engine.callTool('smoke_note_write', input), /INVALID_ARGUMENTS/);
  await assert.rejects(f.engine.callTool('smoke_note_read', { requestId: smokeId, path: 'profile.md' }), /INVALID_ARGUMENTS/);
  await f.engine.callTool('smoke_note_write', { requestId: smokeId, text: 'safe smoke' });
  const state = JSON.parse(await fs.readFile(f.state)); state.text = 'changed outside'; await fs.writeFile(f.state, JSON.stringify(state));
  await assert.rejects(f.engine.callTool('smoke_note_read', { requestId: smokeId }), /readback differs/);
  f.library.revision = 'sha256:' + 'b'.repeat(64); await f.saveRegistry();
  await assert.rejects(f.engine.callTool('smoke_note_write', { requestId: smokeId, text: 'safe smoke' }), /TOOL_UNAVAILABLE/);
  await assert.rejects(fs.stat(path.join(f.home, 'workspace-writer.lock')), { code: 'ENOENT' });
});

test('provider unsafe-path/busy failures never fall back to filesystem writes or leak errors', async t => {
  const f = await smokeFixture(t);
  await fs.writeFile(path.join(f.root, 'reject'), 'simulate Library symlink or writer-lock denial');
  const response = await rpc(f.engine, [...init, call('smoke_note_write', { requestId: smokeId, text: 'safe smoke' })]);
  assert.equal(response[1].result.isError, true);
  assert.equal(response[1].result.content[0].text, 'EXTERNAL_OPERATION_UNCONFIRMED');
  await assert.rejects(fs.stat(f.state), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.home, 'workspace-writer.lock')), { code: 'ENOENT' });
  const noGrant = await fixture(t, false), engine = await openExternalEnvironment(noGrant.file);
  await assert.rejects(engine.callTool('smoke_note_write', { requestId: smokeId, text: 'safe smoke' }), /UNKNOWN_TOOL/);
});

test('smoke grant cannot choose a path or bypass revocation and native workspace ownership', async t => {
  const f = await smokeFixture(t), release = await workspaceLease(f.home, { kind: 'native' });
  try { await assert.rejects(f.engine.callTool('smoke_note_write', { requestId: smokeId, text: 'safe smoke' }), /busy/); }
  finally { await release(); }
  await assert.rejects(fs.stat(f.state), { code: 'ENOENT' });
  f.grant.smokeNote.path = 'profile.md'; await f.saveGrant();
  await assert.rejects(f.engine.callTool('smoke_note_write', { requestId: smokeId, text: 'safe smoke' }), /BINDING_CHANGED/);
  await assert.rejects(openExternalEnvironment(f.file), /INVALID_BINDING/);
});
