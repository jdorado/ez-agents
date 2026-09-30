import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { registry } from './plugins/manager.mjs';
import { invokeLease } from './plugins/workspace-lease.mjs';
import { invokeExternalRead } from './plugin-broker.mjs';

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

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
    if (!keys(grant, ['schemaVersion','id','toolsHome','workspace','contextPaths','tools']) ||
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
      typeof tool.name !== 'string' || !ID.test(tool.name) || tool.name === 'environment_bootstrap' || typeof tool.command !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(tool.command) ||
      typeof tool.revision !== 'string' || !REVISION.test(tool.revision) || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 500) ||
      new Set(tools.map(tool => tool.name)).size !== tools.length) deny('INVALID_BINDING');
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
    return {
      async listTools() {
        await verify();
        for (const tool of tools) await permitted(tool);
        return [{ name: 'environment_bootstrap', description: 'Read explicitly approved environment instructions and state metadata; no model session or write.', inputSchema: emptySchema,
          annotations: { readOnlyHint: true, destructiveHint: false } }, ...tools.map(tool => ({ name: tool.name,
          description: tool.description, inputSchema: emptySchema, annotations: { readOnlyHint: true, destructiveHint: false } }))];
      },
      async callTool(name, args = {}) {
        if (!object(args) || Object.keys(args).length) deny('INVALID_ARGUMENTS');
        await verify();
        const receipt = { id: randomUUID(), environment: grant.id, binding: hash(raw), startedAt: new Date().toISOString() };
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
            data = { environment: grant.id, context, permissions: { readOnly: true, tools: tools.map(tool => tool.name) },
              state: { persistence: 'existing plugin and Library stores', ownership: 'per-call existing workspace lease; no external writer session' } };
          } finally { await release(); }
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
