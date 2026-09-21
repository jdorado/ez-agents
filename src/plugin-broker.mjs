import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCommand, registry, run as dockerRun, stewardOwned } from './plugins/manager.mjs';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_ARGS = 100;
const MAX_ARG_BYTES = 8192;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MANAGER_OUTPUT_BYTES = 256 * 1024;
const ADMISSION_TTL_MS = 30_000;
const RUN_ID = /^[A-Za-z0-9_-]{1,160}$/;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,39}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const REQUEST_ID = /^[a-f0-9-]{36}$/;

const { authorizeRun, deliverySocketPath } = await import('./delivery-socket.js');

const childOf = (candidate, parent) => candidate === parent || candidate.startsWith(parent + path.sep);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const boundedString = (value, limit, name) => {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > limit) throw Error(`Invalid ${name}`);
  return value;
};
const validId = (value, pattern, name) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw Error(`Invalid ${name}`);
  return value;
};
const validateArgs = value => {
  if (!Array.isArray(value) || value.length > MAX_ARGS || value.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > MAX_ARG_BYTES))
    throw Error('Invalid literal plugin arguments');
  return value;
};
const validateRevision = value => validId(value, REVISION, 'plugin revision');

const safeEnvironment = (binding, runId) => {
  const names = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'BUILDX_CONFIG', 'EZ_DOCKER_COMPOSE', 'EZ_DELIVERY_SOCKET'];
  const environment = Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  return { ...environment, EZ_CONTROL_DIR: binding.controlDir, EZ_RUN_ID: runId, EZ_EXECUTOR_TRANSPORT: 'local', EZ_DELIVERY_SOCKET: environment.EZ_DELIVERY_SOCKET ?? deliverySocketPath(binding.controlDir) };
};

const recordForAlias = (r, alias) => {
  validId(alias, IDENTIFIER, 'plugin alias');
  const plugin = r.commands?.[alias];
  const record = typeof plugin === 'string' ? r.plugins?.[plugin] : undefined;
  const command = record?.manifest?.commands?.[alias];
  if (!record || !command || record.manifest.id !== plugin || record.deployment?.commands?.[alias] === undefined)
    throw Error('Unknown or unavailable registered CLI');
  validateRevision(record.revision);
  return { plugin, record, command };
};

const validateManagerArgs = async (value, workspace) => {
  const args = validateArgs(value);
  if (!args.length) throw Error('Missing broker management command');
  const [group, action, name, extra, ...tail] = args;
  if (group === 'tools' && action === 'list' && (args.length === 2 || args.length === 3 && name === '--details')) return args;
  if (group === 'tools' && action === 'exposure' && args.length === 2) return args;
  if (group === 'plugins' && action === 'available' && args.length === 2) return args;
  if (group === 'plugins' && action === 'list' && args.length === 2) return args;
  if (group === 'status' && args.length === 1) return args;
  if (group === 'plugins' && ['inspect', 'install', 'start', 'stop', 'status', 'logs', 'uninstall'].includes(action) && IDENTIFIER.test(name) && args.length === 3) return args;
  if (group === 'plugins' && ['inspect', 'install'].includes(action) && IDENTIFIER.test(name) &&
      args.length === 7 && extra === '--source' && tail[1] === '--revision' && REVISION.test(tail[2])) {
    const source = tail[0];
    if (!workspace || !path.isAbsolute(source)) throw Error('Plugin source must be an absolute path inside the agent workspace');
    let resolved;
    try { resolved = await fs.realpath(source); } catch { throw Error('Plugin source must be an existing path inside the agent workspace'); }
    if (!childOf(resolved, workspace)) throw Error('Plugin source must stay inside the agent workspace');
    return args;
  }
  if (group === 'plugins' && action === 'catalog-add' && IDENTIFIER.test(name) &&
      args.length === 7 && extra === '--source' && tail[1] === '--revision' && REVISION.test(tail[2])) {
    const source = tail[0];
    if (!workspace || !path.isAbsolute(source)) throw Error('Plugin source must be an absolute path inside the agent workspace');
    let resolved;
    try { resolved = await fs.realpath(source); } catch { throw Error('Plugin source must be an existing path inside the agent workspace'); }
    if (!childOf(resolved, workspace)) throw Error('Plugin source must stay inside the agent workspace');
    return args;
  }
  if (group === 'plugins' && ['shared-enable', 'shared-disable', 'shared-status'].includes(action) && IDENTIFIER.test(name) && IDENTIFIER.test(extra) && args.length === 4) return args;
  if (group === 'updates') {
    if (!action || (action === '--help' && args.length === 2)) return args;
    if (action === 'status' && args.length === 2) return args;
    if (action === 'policy' && (args.length === 3 || args.length === 4) && IDENTIFIER.test(name) &&
        (args.length === 3 || ['stable', 'beta', 'manual'].includes(extra))) return args;
    if (action === 'prepare' && args.length === 5 && IDENTIFIER.test(name) && extra === '--file' &&
        typeof tail[0] === 'string' && path.isAbsolute(tail[0])) {
      let resolved;
      try { resolved = await fs.realpath(tail[0]); } catch { throw Error('Upgrade candidate must be an existing file inside the agent workspace'); }
      if (!childOf(resolved, workspace)) throw Error('Upgrade candidate must stay inside the agent workspace');
      return args;
    }
    if (action === 'apply' && (args.length === 3 || args.length === 4) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name) &&
        (args.length === 3 || extra === '--automatic')) return args;
    if (action === 'recover' && args.length === 3 &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)) return args;
  }
  throw Error('Management command is not allowed through the isolated plugin broker');
};

const hashPath = value => createHash('sha256').update(value).digest('hex');

export async function loadPluginBrokerBinding(input) {
  const required = ['home', 'workspace', 'controlDir', 'socket', 'hostConfig'];
  if (!input || required.some(key => typeof input[key] !== 'string' || !path.isAbsolute(input[key]))) throw Error('Plugin broker requires absolute agent bindings');
  const home = await fs.realpath(input.home);
  const workspace = await fs.realpath(input.workspace);
  const controlDir = await fs.realpath(input.controlDir);
  const hostConfig = await fs.realpath(input.hostConfig);
  const socket = path.resolve(input.socket);
  if (home === workspace || home === controlDir || workspace === controlDir) throw Error('Plugin broker bindings must be separate');
  if (!childOf(socket, controlDir) || path.extname(socket) !== '.sock' || socket.length > 100) throw Error('Plugin broker socket must stay inside the agent control directory and fit the Unix socket limit');
  if (childOf(hostConfig, home) || childOf(hostConfig, workspace) || childOf(hostConfig, controlDir)) throw Error('Plugin broker host binding must stay outside agent state');
  const config = await json(path.join(home, 'config.json'));
  if (config.schemaVersion !== 1 || config.workspace !== workspace || config.hostConfig !== hostConfig) throw Error('Plugin registry belongs to another agent');
  const host = await json(hostConfig);
  if (host.isolation !== 'isolated' || !Array.isArray(host.agents)) throw Error('Plugin broker requires an isolated agent binding');
  const agents = host.agents.filter(agent => agent && typeof agent === 'object' && typeof agent.toolsHome === 'string' && typeof agent.workspace === 'string' && typeof agent.controlDir === 'string');
  const matches = [];
  for (const agent of agents) {
    try {
      if (await fs.realpath(agent.toolsHome) === home && await fs.realpath(agent.workspace) === workspace && await fs.realpath(agent.controlDir) === controlDir) matches.push(agent);
    } catch { /* a broken sibling binding is not this broker's authority */ }
  }
  if (matches.length !== 1) throw Error('Plugin broker registry is not owned by exactly one isolated agent');
  const r = await registry(home);
  for (const [plugin, record] of Object.entries(r.plugins)) {
    if (!IDENTIFIER.test(plugin) || !REVISION.test(record.revision) || typeof record.source !== 'string' || !path.isAbsolute(record.source) || !childOf(record.source, home))
      throw Error('Plugin registry contains an unsafe agent binding');
  }
  const timeoutMs = input.timeoutMs === undefined ? 300_000 : Number(input.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) throw Error('Invalid plugin broker timeout');
  return { home, workspace, controlDir, hostConfig, socket, agent: String(matches[0].name || hashPath(home).slice(0, 16)), timeoutMs };
}

const authorize = async (binding, runId) => {
  validId(runId, RUN_ID, 'plugin run ID');
  return authorizeRun(binding.controlDir, runId);
};

const writeReceipt = async (binding, receipt) => {
  const receipts = path.join(binding.controlDir, 'plugin-receipts');
  const directory = path.join(receipts, receipt.runId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await stewardOwned(receipts);
  await stewardOwned(directory);
  const file = path.join(directory, `${receipt.receiptId}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  await stewardOwned(file);
  return file;
};

const response = (socket, value) => {
  if (socket.destroyed || !socket.writable) return;
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > MAX_FRAME) return socket.destroy(new Error('Broker response exceeds frame limit'));
  socket.end(text);
};

const terminate = child => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }, 2_000).unref();
};

const managerCommand = async (binding, args, signal, runId) => new Promise((resolve, reject) => {
  const entry = fileURLToPath(new URL('../bin/ezenciel-agents-tools.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--home', binding.home, ...args], {
    cwd: binding.workspace,
    env: safeEnvironment(binding, runId),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '', stderr = '', bytes = 0, failure;
  const collect = (chunk, error) => {
    bytes += chunk.length;
    if (bytes > MAX_MANAGER_OUTPUT_BYTES) {
      failure = Error('Plugin broker management output limit exceeded');
      terminate(child);
      return;
    }
    if (error) stderr += chunk.toString(); else stdout += chunk.toString();
  };
  child.stdout.on('data', chunk => collect(chunk, false));
  child.stderr.on('data', chunk => collect(chunk, true));
  const abort = () => { failure = Error('Plugin broker request cancelled'); terminate(child); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { failure = Error('Plugin broker management timed out'); terminate(child); }, binding.timeoutMs);
  child.stdin.end();
  child.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); });
  child.once('close', code => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (failure) return reject(failure);
    resolve({ code: code ?? 1, stdout, stderr });
  });
});

const invokePlugin = async (binding, request, signal) => {
  const startedAt = new Date().toISOString();
  let plugin = request.alias;
  let revision = request.revision;
  let result;
  let failure;
  try {
    await authorize(binding, request.runId);
    const current = await registry(binding.home);
    const selected = recordForAlias(current, request.alias);
    plugin = selected.plugin;
    revision = selected.record.revision;
    if (selected.record.revision !== request.revision) throw Error('Plugin changed; discover again');
    const command = await prepareCommand(binding.home, request.alias, request.args, {
      revision: request.revision,
      invocation: true,
      environment: { EZ_CONTROL_DIR: binding.controlDir, EZ_RUN_ID: request.runId, EZ_DELIVERY_SOCKET: process.env.EZ_DELIVERY_SOCKET ?? deliverySocketPath(binding.controlDir) },
    });
    try {
      result = await dockerRun(command.argv, {
        container: command.container,
        capture: true,
        stdin: request.stdin,
        signal,
        timeoutMs: binding.timeoutMs,
        maxBytes: MAX_OUTPUT_BYTES,
      });
    } finally {
      await command.release?.();
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Plugin invocation failed';
  }
  const endedAt = new Date().toISOString();
  const receipt = {
    version: 1,
    kind: 'plugin-invocation',
    receiptId: request.id,
    agent: binding.agent,
    runId: request.runId,
    plugin,
    alias: request.alias,
    revision,
    startedAt,
    endedAt,
    status: failure ? 'failed' : result.code === 0 ? 'completed' : 'plugin-failed',
    exitCode: failure ? 1 : result.code,
    stdinBytes: Buffer.byteLength(request.stdin || ''),
    stdoutBytes: Buffer.byteLength(result?.stdout || ''),
    stderrBytes: Buffer.byteLength(result?.stderr || ''),
    ...(failure ? { error: failure } : {}),
  };
  const receiptPath = await writeReceipt(binding, receipt);
  if (failure) return { ok: false, error: failure, receipt, receiptPath };
  return { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr, receipt, receiptPath };
};

export async function validateBrokerRequest(request, workspace) {
  if (!request || typeof request !== 'object' || request.version !== 1 || !REQUEST_ID.test(request.id)) throw Error('Invalid plugin broker request');
  if (!['resolve', 'invoke', 'manager'].includes(request.operation)) throw Error('Unknown plugin broker operation');
  validId(request.runId, RUN_ID, 'plugin run ID');
  if (request.operation === 'manager') {
    await validateManagerArgs(request.args, workspace);
    if (Object.keys(request).some(key => !['version', 'id', 'operation', 'runId', 'args'].includes(key))) throw Error('Unexpected broker management field');
  } else {
    validId(request.alias, IDENTIFIER, 'plugin alias');
    if (request.operation === 'resolve') {
      if (Object.keys(request).some(key => !['version', 'id', 'operation', 'runId', 'alias'].includes(key))) throw Error('Unexpected broker resolve field');
    } else {
      validateRevision(request.revision);
      validateArgs(request.args);
      if (request.stdin !== undefined) boundedString(request.stdin, MAX_STDIN_BYTES, 'plugin stdin');
      if (typeof request.capability !== 'string' || request.capability.length < 32 || request.capability.length > 128 || !/^[A-Za-z0-9_-]+$/.test(request.capability)) throw Error('Invalid plugin broker capability');
      if (Object.keys(request).some(key => !['version', 'id', 'operation', 'runId', 'alias', 'revision', 'args', 'stdin', 'capability'].includes(key))) throw Error('Unexpected broker invoke field');
    }
  }
  return request;
}

export async function servePluginBroker(binding, signal = new AbortController().signal) {
  await fs.mkdir(path.dirname(binding.socket), { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.lstat(binding.socket);
    if (!existing.isSocket()) throw Error('Plugin broker socket path is not a socket');
    await fs.rm(binding.socket);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const admissions = new Map();
  const server = createServer({ allowHalfOpen: true }, socket => {
    let buffer = '', handled = false;
    const abort = new AbortController();
    socket.on('error', () => abort.abort());
    socket.on('close', () => abort.abort());
    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(new Error('Broker request exceeds frame limit')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      let request;
      try { request = JSON.parse(buffer.slice(0, end)); } catch (error) { response(socket, { version: 1, ok: false, error: 'Invalid JSON request' }); return; }
      (async () => {
        try {
          await validateBrokerRequest(request, binding.workspace);
          if (request.operation === 'resolve') {
            await authorize(binding, request.runId);
            const selected = recordForAlias(await registry(binding.home), request.alias);
            const capability = randomBytes(48).toString('base64url');
            if (admissions.size >= 512) admissions.delete(admissions.keys().next().value);
            admissions.set(capability, { runId: request.runId, alias: request.alias, revision: selected.record.revision, expiresAt: Date.now() + ADMISSION_TTL_MS });
            setTimeout(() => admissions.delete(capability), ADMISSION_TTL_MS).unref();
            response(socket, { version: 1, id: request.id, ok: true, plugin: selected.plugin, alias: request.alias, revision: selected.record.revision, capability });
            return;
          }
          if (request.operation === 'manager') {
            await authorize(binding, request.runId);
            const result = await managerCommand(binding, request.args, abort.signal, request.runId);
            response(socket, { version: 1, id: request.id, ok: true, ...result });
            return;
          }
          const admission = admissions.get(request.capability);
          admissions.delete(request.capability);
          if (!admission || admission.expiresAt < Date.now() || admission.runId !== request.runId || admission.alias !== request.alias || admission.revision !== request.revision)
            throw Error('Invalid or expired plugin broker capability');
          const result = await invokePlugin(binding, request, abort.signal);
          response(socket, { version: 1, id: request.id, ...result });
        } catch (error) {
          response(socket, { version: 1, id: request.id, ok: false, error: error instanceof Error ? error.message : 'Plugin broker request failed' });
        }
      })();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(binding.socket, () => { server.off('error', reject); resolve(); });
  });
  // World-writable is deliberate: the root broker and the dropped-privilege
  // relay share only this agent-private control directory (0700, never
  // mounted elsewhere). Per-request capability auth still gates every call.
  await fs.chmod(binding.socket, 0o666);
  const stop = () => {
    for (const admission of admissions.keys()) admissions.delete(admission);
    server.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  await new Promise(resolve => server.once('close', resolve));
  signal.removeEventListener('abort', stop);
  await fs.rm(binding.socket, { force: true });
}

const option = (args, name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const input = {
    home: option(args, '--home') || process.env.EZ_PLUGIN_BROKER_HOME,
    workspace: option(args, '--workspace') || process.env.EZ_PLUGIN_BROKER_WORKSPACE,
    controlDir: option(args, '--control-dir') || process.env.EZ_PLUGIN_BROKER_CONTROL_DIR,
    socket: option(args, '--socket') || process.env.EZ_PLUGIN_BROKER_SOCKET,
    hostConfig: option(args, '--host-config') || process.env.EZ_PLUGIN_BROKER_HOST_CONFIG,
    timeoutMs: option(args, '--timeout-ms') || process.env.EZ_PLUGIN_BROKER_TIMEOUT_MS,
  };
  if (args.some((value, index) => value.startsWith('--') && !['--home', '--workspace', '--control-dir', '--socket', '--host-config', '--timeout-ms'].includes(value) || value.startsWith('--') && index + 1 >= args.length)) throw Error('Unknown plugin broker option');
  const binding = await loadPluginBrokerBinding(input);
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  await servePluginBroker(binding, abort.signal);
}
