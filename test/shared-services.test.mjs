import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedService, sharedIdentity, attachShared } from '../src/plugins/shared.mjs';
import { validate } from '../src/plugins/manager.mjs';

const record = () => ({ manifest: { id: 'library' }, revision: 'sha256:' + 'a'.repeat(64), source: '/reviewed', sharedRevisions: { embeddings: 'c'.repeat(64) }, deployment: {
  sharedServices: { embeddings: { files: ['worker.mjs'], identity: 'qmd-embeddings-v1', buildTarget: 'embeddings', memoryMiB: 2048, healthcheck: ['node', 'health.mjs'], clients: ['library'], clientEnvironment: { EMBED_SOCKET: '/inference/worker.sock' } } }
} });
function daemon() {
  const objects = new Map(), calls = [];
  const run = async a => {
    calls.push(a);
    if (a[1] === 'inspect') {
      const value = objects.get(a[2]);
      return value ? { code: 0, stdout: JSON.stringify([value]) } : { code: 1, stderr: 'No such object' };
    }
    const labels = Object.fromEntries(a.flatMap((v, i) => v === '--label' ? [a[i+1].split('=')] : []));
    if (a[0] === 'volume' && a[1] === 'create') objects.set(a.at(-1), objects.get(a.at(-1)) || { Labels: labels });
    if (a[0] === 'create') {
      const name = a[a.indexOf('--name')+1];
      if (objects.has(name)) return { code: 1, stderr: 'Conflict: name already in use' };
      objects.set(name, { Config: { Labels: labels }, State: { Status: 'created' } });
    }
    return { code: 0, stdout: '' };
  };
  return { objects, calls, run };
}
test('concurrent first enables converge; status does not create or start anything', async () => {
  const d = daemon(), r = record();
  assert.equal((await sharedService(r, 'embeddings', 'status', d.run)).state, 'absent');
  assert(d.calls.every(a => a[1] === 'inspect'));
  const results = await Promise.all([sharedService(r, 'embeddings', 'enable', d.run), sharedService(r, 'embeddings', 'enable', d.run)]);
  assert.equal(results[0].name, results[1].name);
  assert.equal([...d.objects.keys()].filter(k => !k.endsWith('-ipc') && !k.endsWith('-models')).length, 1);
  const count = d.calls.length;
  await sharedService(r, 'embeddings', 'enable', d.run);
  assert(!d.calls.slice(count).some(a => a[0] === 'create' || a[0] === 'build'));
  assert(!d.calls.some(a => a.includes('/var/run/docker.sock') || a.includes('--publish')));
});
test('foreign containers, foreign volumes and incompatible revisions are never adopted', async () => {
  for (const kind of ['container', 'volume']) {
    const d = daemon(), r = record(), { name } = sharedIdentity(r, 'embeddings');
    d.objects.set(name + (kind === 'volume' ? '-ipc' : ''), { Labels: {} });
    await assert.rejects(sharedService(r, 'embeddings', 'enable', d.run), /Unowned or incompatible/);
    assert(!d.calls.some(a => a[0] === 'start' || a[0] === 'rm'));
  }
  const d = daemon(), r = record(); await sharedService(r, 'embeddings', 'enable', d.run);
  r.revision = 'sha256:' + 'b'.repeat(64);
  await sharedService(r, 'embeddings', 'enable', d.run);
  r.sharedRevisions.embeddings = 'd'.repeat(64);
  await assert.rejects(sharedService(r, 'embeddings', 'enable', d.run), /incompatible/);
});
test('disabled compose has no shared resources; enabled clients mount only read-only IPC', () => {
  const r = record(), c = () => ({ services: { library: { volumes: [] } }, volumes: {} });
  assert.deepEqual(attachShared(c(), r), c());
  r.sharedEnabled = ['embeddings'];
  const result = attachShared(c(), r);
  assert.equal(result.services.library.volumes[0].read_only, true);
  assert.equal(result.services.library.volumes[0].target, '/inference');
  assert(!JSON.stringify(result).includes('-models'));
});
test('schema 3 rejects unauthorized shared fields, clients and mount collisions', () => {
  const m = { schemaVersion: 1, id: 'library', version: '0.1.0', commands: {}, skills: [] };
  const make = () => ({ schemaVersion: 3, services: { library: { buildTarget: 'runtime', healthcheck: ['true'] } }, commands: {}, ...record().deployment });
  validate(m, make(), new Map([['worker.mjs', {}]]));
  for (const mutate of [d => d.sharedServices.embeddings.socket = '/var/run/docker.sock', d => d.sharedServices.embeddings.clients = ['foreign'], d => d.services.library.volumes = { data: '/inference' }, d => d.sharedServices.embeddings.clientEnvironment.BAD = '$TOKEN', d => d.schemaVersion = 2]) {
    const d = make(); mutate(d); assert.throws(() => validate(m, d, new Map([['worker.mjs', {}]])));
  }
});

test('cancelled creation never starts a possibly created container', async () => {
  const d = daemon();
  const run = async a => { const result = await d.run(a); return a[0] === 'create' ? { code: 130, stderr: 'cancelled' } : result; };
  await assert.rejects(sharedService(record(), 'embeddings', 'enable', run), /cancelled/);
  assert(!d.calls.some(a => a[0] === 'start'));
});
