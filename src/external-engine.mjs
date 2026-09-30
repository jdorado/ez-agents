import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { registry } from './plugins/manager.mjs';
import { invokeLease } from './plugins/workspace-lease.mjs';
import { invokeExternalRead, invokeExternalSmokeNote } from './plugin-broker.mjs';

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const packageInfo = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const externalRuntime = { version: packageInfo.version, sourceCommit: packageInfo.ezQa?.commit ?? null };
const smokeSchema = write => ({ type: 'object', properties: { requestId: { type: 'string', format: 'uuid' },
  ...(write ? { text: { type: 'string', minLength: 1, maxLength: 1024 } } : {}) },
  required: write ? ['requestId', 'text'] : ['requestId'], additionalProperties: false });

export class ExternalEngineError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const deny = code => { throw new ExternalEngineError(code); };

async function boundedRead(file, limit) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) deny('CONTEXT_UNAVAILABLE');
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit) deny('CONTEXT_UNAVAILABLE');
    return buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}

// Grant files are host-owned policy, outside the mind and plugin installation.
// Missing tools/context arrays mean no exposure. Each process binds one environment.
export async function openExternalEnvironment(file) {
  try {
    if (!path.isAbsolute(file)) deny('INVALID_BINDING');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || (stat.mode & 0o022) || stat.uid !== process.getuid?.()) deny('INVALID_BINDING');
    const raw = await boundedRead(file, 32_768), grant = JSON.parse(raw);
    if (!keys(grant, ['schemaVersion','id','toolsHome','workspace','contextPaths','tools','smokeNote']) ||
        grant.schemaVersion !== 1 || typeof grant.id !== 'string' || !ID.test(grant.id) ||
        !path.isAbsolute(grant.toolsHome || '') || !path.isAbsolute(grant.workspace || '')) deny('INVALID_BINDING');
    const home = await fs.realpath(grant.toolsHome), workspace = await fs.realpath(grant.workspace);
    const canonicalFile = await fs.realpath(file);
    if (inside(canonicalFile, home) || inside(canonicalFile, workspace) || inside(home, workspace) || inside(workspace, home)) deny('INVALID_BINDING');
    const configRaw = await boundedRead(path.join(home, 'config.json'), 32_768);
    const config = JSON.parse(configRaw);
    if (config.schemaVersion !== 1 || await fs.realpath(config.workspace) !== workspace) deny('INVALID_BINDING');
    const contextPaths = grant.contextPaths ?? [], tools = grant.tools ?? [];
    if (!Array.isArray(contextPaths) || contextPaths.length > 8 || new Set(contextPaths).size !== contextPaths.length ||
        contextPaths.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_./-]+\.md$/.test(value) ||
          value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /^(private|secrets|control|tools|node_modules)$/i.test(part)))) deny('INVALID_BINDING');
    if (!Array.isArray(tools) || tools.length > 32 || tools.some(tool => !keys(tool, ['name','command','revision','description']) ||
      typeof tool.name !== 'string' || !ID.test(tool.name) || ['environment_bootstrap','smoke_note_write','smoke_note_read'].includes(tool.name) || typeof tool.command !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(tool.command) ||
      typeof tool.revision !== 'string' || !REVISION.test(tool.revision) || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 500) ||
      new Set(tools.map(tool => tool.name)).size !== tools.length) deny('INVALID_BINDING');
    const smoke = grant.smokeNote;
    if (smoke !== undefined && (!keys(smoke, ['revision','library']) || typeof smoke.revision !== 'string' || !REVISION.test(smoke.revision) ||
      typeof smoke.library !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(smoke.library))) deny('INVALID_BINDING');
    const binding = { home, workspace };
    const verify = async () => {
      const current = await fs.lstat(file);
      if (!current.isFile() || current.uid !== stat.uid || (current.mode & 0o022) || hash(await boundedRead(file, 32_768)) !== hash(raw)) deny('BINDING_CHANGED');
      const currentConfig = await boundedRead(path.join(home, 'config.json'), 32_768);
      if (hash(currentConfig) !== hash(configRaw)) deny('BINDING_CHANGED');
      const config = JSON.parse(currentConfig);
      if (await fs.realpath(grant.toolsHome) !== home || await fs.realpath(grant.workspace) !== workspace ||
          await fs.realpath(config.workspace) !== workspace) deny('BINDING_CHANGED');
    };
    const permitted = async tool => {
      const installed = await registry(home), plugin = installed.commands[tool.command], record = installed.plugins[plugin];
      const command = record?.manifest?.commands?.[tool.command];
      if (!record || record.revision !== tool.revision || record.manifest.id !== plugin || command?.externalRead !== true ||
          command.exposure?.changesRecords !== false || command.exposure?.requiresReview !== false) deny('TOOL_UNAVAILABLE');
    };
    const smokePermitted = async () => {
      const installed = await registry(home), record = installed.plugins?.library;
      const command = record?.manifest?.commands?.library, deployed = record?.deployment?.commands?.library;
      if (installed.commands.library !== 'library' || record?.revision !== smoke.revision || record?.manifest?.id !== 'library' ||
          command?.executable !== 'bin/ez-library.mjs' || !Array.isArray(command.args) || command.args.length ||
          JSON.stringify(deployed?.argv) !== JSON.stringify(['node', '/app/bin/ez-library.mjs']) || (deployed?.suffix?.length ?? 0)) deny('TOOL_UNAVAILABLE');
    };
    return {
      async listTools() {
        await verify();
        for (const tool of tools) await permitted(tool);
        if (smoke) await smokePermitted();
        return [{ name: 'environment_bootstrap', description: 'Read explicitly approved environment instructions and state metadata; no model session or write.', inputSchema: emptySchema,
          annotations: { readOnlyHint: true, destructiveHint: false } }, ...tools.map(tool => ({ name: tool.name,
          description: tool.description, inputSchema: emptySchema, annotations: { readOnlyHint: true, destructiveHint: false } })),
          ...(smoke ? [{ name: 'smoke_note_write', description: 'Create only one new isolated smoke note through Library; existing records cannot be replaced. Retain requestId for reconciliation.',
            inputSchema: smokeSchema(true), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
          { name: 'smoke_note_read', description: 'Read only the note proved by its scoped Library operation receipt; no Library search or arbitrary paths.',
            inputSchema: smokeSchema(false), annotations: { readOnlyHint: true, destructiveHint: false } }] : [])];
      },
      async callTool(name, args = {}) {
        const smokeCall = name === 'smoke_note_write' || name === 'smoke_note_read';
        if (!object(args) || (!smokeCall && Object.keys(args).length)) deny('INVALID_ARGUMENTS');
        await verify();
        const receipt = { id: randomUUID(), environment: grant.id, binding: hash(raw), runtime: externalRuntime, startedAt: new Date().toISOString() };
        let data;
        if (name === 'environment_bootstrap') {
          const release = await invokeLease(home);
          try {
            const context = [];
            let bytes = 0;
            for (const relative of contextPaths) {
              let target = workspace;
              for (const part of relative.split('/')) {
                target = path.join(target, part);
                if ((await fs.lstat(target)).isSymbolicLink()) deny('CONTEXT_UNAVAILABLE');
              }
              if (!inside(await fs.realpath(target), workspace)) deny('CONTEXT_UNAVAILABLE');
              const text = await boundedRead(target, 32_768);
              bytes += Buffer.byteLength(text);
              // Credential-shaped content is denied, never partially disclosed.
              if (bytes > 65_536 || /-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{16,}/i.test(text)) deny('CONTEXT_UNAVAILABLE');
              context.push({ path: relative, sha256: hash(text), text });
            }
            data = { environment: grant.id, runtime: externalRuntime, context, permissions: { readOnly: true, tools: tools.map(tool => tool.name) },
              state: { persistence: 'existing plugin and Library stores', ownership: 'per-call existing workspace lease; no external writer session' } };
            if (smoke) {
              await smokePermitted();
              data.permissions.readOnly = false;
              data.permissions.tools.push('smoke_note_write', 'smoke_note_read');
              data.permissions.smokePath = `notes/ez-external-smoke/${grant.id}.md`;
            }
          } finally { await release(); }
        } else if (smokeCall) {
          if (!smoke) deny('UNKNOWN_TOOL');
          if (!keys(args, name === 'smoke_note_write' ? ['requestId','text'] : ['requestId']) || typeof args.requestId !== 'string' ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.requestId) ||
            (name === 'smoke_note_write' && (typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text) > 1024 || args.text.includes('\0')))) deny('INVALID_ARGUMENTS');
          await smokePermitted();
          data = await invokeExternalSmokeNote(binding, smoke, grant.id, name === 'smoke_note_write' ? 'write' : 'read', args);
          receipt.pluginRevision = smoke.revision;
        } else {
          const tool = tools.find(tool => tool.name === name);
          if (!tool) deny('UNKNOWN_TOOL');
          await permitted(tool);
          data = await invokeExternalRead(binding, tool.command, tool.revision);
          receipt.pluginRevision = tool.revision;
        }
        return { data, receipt: { ...receipt, endedAt: new Date().toISOString(), status: 'completed' } };
      },
    };
  } catch (error) {
    if (error instanceof ExternalEngineError) throw error;
    deny('INVALID_BINDING');
  }
}
