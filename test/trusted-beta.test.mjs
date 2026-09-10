import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identity, sha256, validateManifest, validateReceipt, validateChecks, tarManifest, validateSource, registryState, publishOnce, githubClient } from '../scripts/trusted-beta.mjs';

const env = { RELEASE_ID: '123', RELEASE_REPOSITORY: 'jdorado/ez-agents', RELEASE_PACKAGE: '@jc_stack/ez-agents', RELEASE_VERSION: '1.2.3-beta.1', RELEASE_SOURCE_SHA: 'a'.repeat(40), RELEASE_SHA256: sha256(Buffer.from('candidate')), RELEASE_REQUIRED_CHECKS: '["verify (22)"]', GITHUB_REPOSITORY: 'jdorado/ez-agents', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40) };
const expected = identity(env);
const manifest = { name: expected.package, version: expected.version, repository: { url: 'git+https://github.com/jdorado/ez-agents.git' }, publishConfig: { access: 'public', tag: 'beta' } };
const receipt = { ...Object.fromEntries(['repository', 'package', 'version', 'sourceSha', 'sha256'].map(key => [key, expected[key]])), independentReviewUrl: 'https://github.com/jdorado/ez-agents/pull/41#issuecomment-123', testEvidenceUrls: ['https://github.com/jdorado/ez-agents/actions/runs/123'] };
const check = { id: 1, details_url: 'https://github.com/jdorado/ez-agents/actions/runs/123/job/456', name: 'verify (22)', head_sha: expected.sourceSha, app: { id: 15368 }, status: 'completed', conclusion: 'success' };

test('identity rejects source, repository, trigger, channel and empty check substitution', () => {
  for (const changed of [{ RELEASE_VERSION: '1.2.3' }, { RELEASE_VERSION: '1.2.3-alpha.1' }, { RELEASE_VERSION: '1.2.3-beta.01' }, { RELEASE_VERSION: '1.2.3-beta.1+build' }, { RELEASE_REPOSITORY: 'attacker/ez-agents' }, { GITHUB_REPOSITORY: 'jdorado/other' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_SHA: 'b'.repeat(40) }, { RELEASE_REQUIRED_CHECKS: '[]' }, { RELEASE_REQUIRED_CHECKS: '["a","a"]' }, { RELEASE_SHA256: 'oops' }]) assert.throws(() => identity({ ...env, ...changed }));
});

test('manifest and receipt are bound to independent dispatch identity', () => {
  validateManifest(manifest, expected); validateReceipt(receipt, expected);
  for (const changed of [{ name: '@jc_stack/other' }, { version: '1.2.3' }, { private: true }, { repository: 'https://github.com/attacker/repo' }, { publishConfig: { tag: 'latest' } }, { publishConfig: { access: 'restricted' } }, { publishConfig: { registry: 'https://evil.example/' } }, { publishConfig: { provenance: false } }]) assert.throws(() => validateManifest({ ...manifest, ...changed }, expected));
  for (const changed of [{ repository: 'jdorado/other' }, { sourceSha: 'b'.repeat(40) }, { sha256: '0'.repeat(64) }, { independentReviewUrl: 'https://evil.example/pull/1' }, { independentReviewUrl: 'https://github.com/jdorado/ez-agents/issues/1' }, { testEvidenceUrls: [] }, { testEvidenceUrls: ['https://github.com/jdorado/ez-agents/actions/runs/1/../../evil'] }]) assert.throws(() => validateReceipt({ ...receipt, ...changed }, expected));
});

test('checks cannot pass vacuously, from another app/source or an earlier run', () => {
  validateChecks([check], expected);
  for (const checks of [[], [{ ...check, app: { id: 1 } }], [{ ...check, head_sha: 'b'.repeat(40) }], [{ ...check, conclusion: 'skipped' }], [check, { ...check, id: 2, status: 'in_progress', conclusion: null }]]) assert.throws(() => validateChecks(checks, expected));
});

function sourceApi(overrides = {}) {
  const responses = {
    '/repos/jdorado/ez-agents/actions/runs/123': { head_sha: expected.sourceSha, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' },
    '/repos/jdorado/ez-agents': { full_name: expected.repository, private: false, visibility: 'public', default_branch: 'main' },
    '/repos/jdorado/ez-agents/contents/docs/plugin-catalog.md?ref=main': { content: Buffer.from('| [Plugin](https://github.com/jdorado/ez-whatsapp) | `@jc_stack/ez-whatsapp` |').toString('base64') },
    '/repos/jdorado/ez-agents/git/ref/heads/main': { object: { sha: expected.sourceSha } },
    [`/repos/jdorado/ez-agents/contents/package.json?ref=${expected.sourceSha}`]: { content: Buffer.from(JSON.stringify(manifest)).toString('base64') },
    [`/repos/jdorado/ez-agents/git/ref/tags/v${expected.version}`]: { object: { type: 'commit', sha: expected.sourceSha } },
    [`/repos/jdorado/ez-agents/commits/${expected.sourceSha}/check-runs?per_page=100&page=1`]: { check_runs: [check] },
    ...overrides,
  };
  return async path => { assert.ok(path in responses, `Unexpected API request ${path}`); return responses[path]; };
}

test('source gates reject private repository, changed main, wrong tag and failed CI', async () => {
  await validateSource(expected, sourceApi());
  for (const override of [
    { '/repos/jdorado/ez-agents': { full_name: expected.repository, private: true, visibility: 'private', default_branch: 'main' } },
    { '/repos/jdorado/ez-agents/git/ref/heads/main': { object: { sha: 'b'.repeat(40) } } },
    { [`/repos/jdorado/ez-agents/git/ref/tags/v${expected.version}`]: { object: { type: 'commit', sha: 'b'.repeat(40) } } },
    { [`/repos/jdorado/ez-agents/commits/${expected.sourceSha}/check-runs?per_page=100&page=1`]: { check_runs: [] } },
  ]) await assert.rejects(validateSource(expected, sourceApi(override)));
  await assert.rejects(validateSource({ ...expected, repository: 'jdorado/ez-library', package: '@jc_stack/ez-library' }, async path => path.endsWith('ez-library') ? { full_name: 'jdorado/ez-library', private: false, visibility: 'public', default_branch: 'main' } : { content: Buffer.from('').toString('base64') }), /not enrolled/);
});

test('tarball parser reads one regular manifest without extracting files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beta-tar-test-'));
  try {
    await mkdir(join(dir, 'package'));
    await writeFile(join(dir, 'package/package.json'), JSON.stringify(manifest));
    execFileSync('tar', ['-czf', join(dir, 'good.tgz'), '-C', dir, 'package/package.json']);
    assert.deepEqual(tarManifest(join(dir, 'good.tgz')), manifest);
    execFileSync('tar', ['-czf', join(dir, 'duplicate.tgz'), '-C', dir, 'package/package.json', 'package/package.json']);
    assert.throws(() => tarManifest(join(dir, 'duplicate.tgz')), /exactly one/);
    execFileSync('ln', ['-s', '/etc/passwd', join(dir, 'package/link')]);
    execFileSync('tar', ['-czf', join(dir, 'link.tgz'), '-C', dir, 'package']);
    assert.throws(() => tarManifest(join(dir, 'link.tgz')), /links or special/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registry distinguishes missing version, absent package, server failures and changed bytes', async () => {
  const document = { name: expected.package, versions: {}, 'dist-tags': { latest: '1.0.0', beta: '1.2.3-beta.0' } };
  const response = data => new Response(JSON.stringify(data));
  assert.deepEqual(await registryState(expected, async () => response(document)), { exists: false, latest: '1.0.0', beta: '1.2.3-beta.0' });
  await assert.rejects(registryState(expected, async () => new Response('', { status: 404 })), /first reviewed beta/);
  await assert.rejects(registryState(expected, async () => new Response('', { status: 503 })), /HTTP 503/);
  const published = { ...manifest, dist: { tarball: 'https://registry.npmjs.org/file.tgz' } };
  const existing = { ...document, versions: { [expected.version]: published } };
  let n = 0;
  const read = await registryState(expected, async () => n++ === 0 ? response(existing) : new Response('candidate'));
  assert.equal(read.exists, true);
  n = 0;
  await assert.rejects(registryState(expected, async () => n++ === 0 ? response(existing) : new Response('changed')), /differs/);
  await assert.rejects(registryState(expected, async () => response({ ...existing, versions: { [expected.version]: { ...published, dist: { tarball: 'https://evil.example/file' } } } })), /tarball host/);
});

test('publish writes once and reconciles a timeout using exact registry readback', async () => {
  let writes = 0; let reads = 0;
  const result = await publishOnce(expected, { readState: async () => reads++ === 0 ? { exists: false, latest: '1.0.0' } : { exists: true, latest: '1.0.0', beta: expected.version }, publishTarball: async () => { writes++; throw new Error('timeout'); }, sleep: async () => {}, report: () => {} });
  assert.equal(writes, 1); assert.equal(result.status, 'published');
});

test('existing matching publication is read-only; partial or changed tag never republished', async () => {
  let writes = 0;
  const options = { readState: async () => ({ exists: true, beta: expected.version }), publishTarball: async () => { writes++; } };
  assert.equal((await publishOnce(expected, options)).status, 'already-published');
  await assert.rejects(publishOnce(expected, { ...options, readState: async () => ({ exists: true, beta: 'other' }) }), /reconcile/);
  assert.equal(writes, 0);
  for (const after of [{ exists: true, latest: 'changed', beta: expected.version }, { exists: true, latest: '1.0.0', beta: 'other' }, { exists: false, latest: '1.0.0' }]) {
    let reads = 0;
    await assert.rejects(publishOnce(expected, { readState: async () => reads++ === 0 ? { exists: false, latest: '1.0.0' } : after, publishTarball: async () => { writes++; }, sleep: async () => {} }), /do not repeat/);
  }
  assert.equal(writes, 3);
});

test('asset redirect never carries GitHub authorization to storage host', async () => {
  let count = 0;
  const api = githubClient('sensitive', async (url, options) => {
    if (count++ === 0) { assert.equal(options.headers.Authorization, 'Bearer sensitive'); return new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } }); }
    assert.equal(options.headers, undefined); return new Response('candidate');
  });
  assert.equal((await api('/repos/jdorado/ez-agents/releases/assets/1', true)).toString(), 'candidate');
  await assert.rejects(githubClient('sensitive', async () => new Response('', { status: 302, headers: { location: 'https://evil.example/file' } }))('/repos/jdorado/ez-agents/releases/assets/1', true), /Unexpected asset redirect/);
});

test('workflow reruns can verify success but cannot repeat an absent-version write', async () => {
  let writes = 0;
  const options = { allowWrite: false, publishTarball: async () => { writes++; } };
  await assert.rejects(publishOnce(expected, { ...options, readState: async () => ({ exists: false }) }), /fresh authorized dispatch/);
  assert.equal((await publishOnce(expected, { ...options, readState: async () => ({ exists: true, beta: expected.version }) })).status, 'already-published');
  assert.equal(writes, 0);
});

test('write-started receipt precedes publication and readback records partial failures', async () => {
  const events = []; let read = 0;
  await assert.rejects(publishOnce(expected, { readState: async () => read++ === 0 ? { exists: false, latest: '1' } : { exists: false, latest: '1' }, record: async event => events.push(event), publishTarball: async () => { assert.equal(events.at(-1).phase, 'write-started'); throw new Error('timeout'); }, sleep: async () => {} }), /unresolved/);
  assert.equal(events[0].phase, 'preflight');
  assert.ok(events.some(event => event.phase === 'readback' && event.publishCommandFailed));
});

test('required check workflow must be main push CI, not a same-named alternate workflow', async () => {
  for (const changed of [{ event: 'pull_request' }, { head_branch: 'feature' }, { path: '.github/workflows/unrelated.yml' }, { conclusion: 'failure' }, { head_sha: 'b'.repeat(40) }]) {
    await assert.rejects(validateSource(expected, sourceApi({ '/repos/jdorado/ez-agents/actions/runs/123': { head_sha: expected.sourceSha, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', ...changed } })), /main push CI/);
  }
});

test('publish environment contains only required platform identity and OIDC capabilities', async () => {
  const { publishEnvironment } = await import('../scripts/trusted-beta.mjs');
  const clean = publishEnvironment({ PATH: '/bin', HOME: '/tmp', GITHUB_SHA: expected.sourceSha, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-only', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', NPM_TOKEN: 'secret', TELEGRAM_BOT_TOKEN: 'secret', npm_config_registry: 'https://evil.example', NODE_OPTIONS: '--require=/evil.js' });
  assert.deepEqual(clean, { PATH: '/bin', HOME: '/tmp', GITHUB_SHA: expected.sourceSha, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-only' });
});

test('generated caller pins shared code, permits manual dispatch only and rejects YAML injection', async () => {
  const { generateCaller } = await import('../scripts/generate-publish-caller.mjs');
  const config = { repository: 'jdorado/ez-whatsapp', packageName: '@jc_stack/ez-whatsapp', publisherSha: 'a'.repeat(40), checks: ['verify (22)', 'docker'] };
  const caller = generateCaller(config);
  assert.ok(caller.includes(`uses: jdorado/ez-agents/.github/workflows/npm-beta-shared.yml@${config.publisherSha}`));
  assert.ok(caller.includes('  workflow_dispatch:'));
  assert.ok(!/^\s+(?:push|pull_request|workflow_run):/m.test(caller));
  assert.ok(caller.includes('      release-id: ${{ inputs.release-id }}'));
  assert.ok(generateCaller({ ...config, repository: 'jdorado/ez-agents', packageName: '@jc_stack/ez-agents' }).includes('uses: ./.github/workflows/npm-beta-shared.yml'));
  for (const invalid of [{ repository: "jdorado/repo'\nsteps:" }, { packageName: "@jc_stack/p'\nsteps:" }, { publisherSha: 'main' }, { checks: ['a\nsteps:'] }, { checks: [] }]) assert.throws(() => generateCaller({ ...config, ...invalid }));
});
