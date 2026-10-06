// Trusted operator diagnostic, executed inside the installed broker. Never a
// socket operation or native-run substitute; no command execution or writes.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadPluginBrokerBinding } from '/app/src/plugin-broker.mjs';
import { registry, snapshot, checkFolders, hostNetworkBindings } from '/app/src/plugins/manager.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function brokerReadiness(input, expected) {
  if (!Array.isArray(expected) || expected.length !== 3 || expected.some(value => !/^[a-f0-9]{64}$/.test(value)))
    throw Error('Expected host, registry and configuration fingerprints');
  const binding = await loadPluginBrokerBinding(input);
  const files = [binding.hostConfig, path.join(binding.home, 'registry.json'), path.join(binding.home, 'config.json')];
  const verify = async () => {
    for (let i = 0; i < files.length; i++) if (hash(await fs.readFile(files[i])) !== expected[i])
      throw Error('Isolated broker configuration fingerprint mismatch');
  };
  await verify();
  if (!(await fs.stat(binding.socket)).isSocket()) throw Error('Isolated broker socket unavailable');
  const config = JSON.parse(await fs.readFile(files[2], 'utf8'));
  const r = await registry(binding.home), plugins = [];
  for (const [id, record] of Object.entries(r.plugins)) {
    const trusted = await snapshot(record.source);
    if (trusted.manifest.id !== id || record.source !== trusted.source || record.revision !== trusted.revision ||
        JSON.stringify(record.manifest) !== JSON.stringify(trusted.manifest) ||
        JSON.stringify(record.deployment) !== JSON.stringify(trusted.deployment) ||
        JSON.stringify(record.sharedRevisions || {}) !== JSON.stringify(trusted.sharedRevisions))
      throw Error('Registry plugin identity is not the reviewed source');
    for (const alias of Object.keys(record.manifest.commands))
      if (r.commands[alias] !== id || !record.deployment.commands[alias]) throw Error('Corrupt command registry');
    await checkFolders(config, record, binding.home);
    await hostNetworkBindings(config, record, binding.home);
    plugins.push({ id, revision: record.revision });
  }
  await verify();
  return { version: 1, ready: true, hostSha256: expected[0], registrySha256: expected[1], configSha256: expected[2], plugins };
}
{
  const args = process.argv.slice(process.argv[1]?.endsWith('/broker-readiness.mjs') ? 2 : 1);
  try {
    const result = await brokerReadiness({
      home: process.env.EZ_PLUGIN_BROKER_HOME, workspace: process.env.EZ_PLUGIN_BROKER_WORKSPACE,
      controlDir: process.env.EZ_PLUGIN_BROKER_CONTROL_DIR, socket: process.env.EZ_PLUGIN_BROKER_SOCKET,
      hostConfig: process.env.EZ_PLUGIN_BROKER_HOST_CONFIG,
    }, args);
    console.log(JSON.stringify(result));
  } catch {
    // Validation exceptions can contain private paths. Keep operator/public
    // readback content-free; updater still retains failure and rollback state.
    console.error('EZ_BROKER_STRUCTURAL_READINESS_FAILED');
    process.exitCode = 1;
  }
}
