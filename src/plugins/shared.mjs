import { setTimeout } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const label = 'com.ez.shared';

export function sharedIdentity(record, key) {
  const spec = record.deployment.sharedServices?.[key];
  if (!spec) throw Error('Undeclared shared service');
  if (!/^[a-f0-9]{64}$/.test(record.sharedRevisions?.[key] || '')) throw Error('Missing reviewed shared implementation revision');
  const name = `ez-shared-${spec.identity}`;
  // Reuse only the exact reviewed implementation. Upgrades never replace a live worker.
  const fingerprint = hash(JSON.stringify([record.manifest.id, record.sharedRevisions?.[key], spec]));
  return { name, fingerprint, spec, image: `${name}:${fingerprint.slice(0,16)}`, labels: { [label]: spec.identity, [`${label}.fingerprint`]: fingerprint } };
}

export async function sharedService(record, key, action, run) {
  const { name, fingerprint, spec, image, labels } = sharedIdentity(record, key);
  const checked = async args => { const r = await run(args, { capture: true }); if (r.code) throw Error(r.stderr || r.stdout || 'Shared service Docker operation failed'); return r.stdout; };
  const inspect = async (kind, target) => {
    const r = await run([kind, 'inspect', target], { capture: true });
    if (!r.code) return JSON.parse(r.stdout)[0];
    if (/No such (object|container|volume)/i.test(r.stderr)) return null;
    throw Error(r.stderr || 'Cannot inspect shared resource');
  };
  const compatible = item => {
    const actual = item.Config?.Labels || item.Labels || {};
    if (Object.entries(labels).some(([k,v]) => actual[k] !== v)) throw Error(`Unowned or incompatible shared resource: ${name}`);
  };
  let container = await inspect('container', name);
  if (container) compatible(container);
  if (action === 'status') return { name, fingerprint, state: container?.State?.Health?.Status || (container ? container.State.Status : 'absent') };
  if (action !== 'enable') throw Error('Unknown shared service action');
  if (!container) {
    await checked(['build', '--target', spec.buildTarget, '--tag', image, record.source]);
    for (const volume of ['ipc', 'models']) {
      const volumeName = `${name}-${volume}`;
      let item = await inspect('volume', volumeName);
      if (!item) {
        await checked(['volume', 'create', ...Object.entries(labels).flatMap(([k,v]) => ['--label', `${k}=${v}`]), volumeName]);
        item = await inspect('volume', volumeName);
      }
      compatible(item);
    }
    const result = await run(['create', '--name', name, ...Object.entries(labels).flatMap(([k,v]) => ['--label', `${k}=${v}`]),
      '--network', 'bridge', '--user', '1000:1000', '--init', '--restart', 'unless-stopped', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--memory', `${spec.memoryMiB}m`, '--pids-limit', '256', '--tmpfs', '/tmp',
      '--mount', `type=volume,src=${name}-ipc,dst=/inference`, '--mount', `type=volume,src=${name}-models,dst=/models`,
      '--health-cmd', spec.healthcheck.map(x => `'${x.replaceAll("'", "'\\''")}'`).join(' '), '--health-interval', '2s', '--health-timeout', '5s', '--health-retries', '30', '--health-start-period', '10m', image], { capture: true });
    // Docker's unique container name is the daemon-wide creation lock.
    container = await inspect('container', name);
    // A concurrent docker create reserves its name before inspect exposes the object.
    if (result.code && /already in use/.test(result.stderr || '')) for (let attempt = 0; !container && attempt < 50; attempt++) {
      await setTimeout(100); container = await inspect('container', name);
    }
    if (!container) throw Error(result.stderr || 'Shared service creation failed');
    compatible(container);
  }
  await checked(['start', name]);
  return { name, fingerprint, state: 'starting', modelVolume: `${name}-models` };
}

export function attachShared(compose, record) {
  for (const key of record.sharedEnabled || []) {
    const { name } = sharedIdentity(record, key);
    const volume = `shared-${key}`;
    compose.volumes[volume] = { external: true, name: `${name}-ipc` };
    for (const service of record.deployment.sharedServices[key].clients) {
      compose.services[service].volumes.push({ type: 'volume', source: volume, target: '/inference', read_only: true });
      compose.services[service].environment = { ...compose.services[service].environment, ...record.deployment.sharedServices[key].clientEnvironment };
    }
  }
  return compose;
}
