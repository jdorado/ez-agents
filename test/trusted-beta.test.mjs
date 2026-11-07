import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identity, sha256, validateManifest, validateReceipt, validateChecks, tarManifest, validateSource, registryState, publishOnce, githubClient, githubTagCreator, githubReleaseWriter, ensureTag, readbackDelays, publicationReceipt, finishRelease, finish } from '../scripts/trusted-beta.mjs';

const env = { RELEASE_ID: '123', RELEASE_REPOSITORY: 'jdorado/ez-agents', RELEASE_PACKAGE: '@jc_stack/ez-agents', RELEASE_VERSION: '1.2.3-beta.1', RELEASE_SOURCE_SHA: 'a'.repeat(40), RELEASE_SHA256: sha256(Buffer.from('candidate')), RELEASE_REQUIRED_CHECKS: '["verify (22)"]', GITHUB_REPOSITORY: 'jdorado/ez-agents', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40) };
const expected = identity(env);
const manifest = { name: expected.package, version: expected.version, repository: { url: 'git+https://github.com/jdorado/ez-agents.git' }, publishConfig: { access: 'public', tag: 'latest' } };
const receipt = { ...Object.fromEntries(['repository', 'package', 'version', 'sourceSha', 'sha256'].map(key => [key, expected[key]])), independentReviewUrl: 'https://github.com/jdorado/ez-agents/pull/41#issuecomment-123', testEvidenceUrls: ['https://github.com/jdorado/ez-agents/actions/runs/123'] };
const mainRun = { id: 123, run_attempt: 1, head_sha: expected.sourceSha, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
const runsPath = `/repos/${expected.repository}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${expected.sourceSha}&per_page=100&page=1`;
const jobsPath = `/repos/${expected.repository}/actions/runs/123/attempts/1/jobs?per_page=100&page=1`;
const checkPath = `/repos/${expected.repository}/check-runs/1`;
const job = { id: 456, run_id: 123, run_attempt: 1, head_sha: expected.sourceSha, name: 'verify (22)', status: 'completed', conclusion: 'success', check_run_url: `https://api.github.com${checkPath}` };
const check = { id: 1, details_url: 'https://github.com/jdorado/ez-agents/actions/runs/123/job/456', name: 'verify (22)', head_sha: expected.sourceSha, app: { id: 15368 }, status: 'completed', conclusion: 'success' };

test('identity rejects source, repository, trigger, channel and empty check substitution', () => {
  for (const changed of [{ RELEASE_VERSION: '1.2.3' }, { RELEASE_VERSION: '1.2.3-alpha.1' }, { RELEASE_VERSION: '1.2.3-beta.01' }, { RELEASE_VERSION: '1.2.3-beta.1+build' }, { RELEASE_REPOSITORY: 'attacker/ez-agents' }, { GITHUB_REPOSITORY: 'jdorado/other' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_SHA: 'b'.repeat(40) }, { RELEASE_REQUIRED_CHECKS: '[]' }, { RELEASE_REQUIRED_CHECKS: '["a","a"]' }, { RELEASE_SHA256: 'oops' }]) assert.throws(() => identity({ ...env, ...changed }));
});

test('identity accepts release-counter 0.N.0 and legacy beta.N versions but no other shape', () => {
  for (const version of ['0.70.0', '0.2.0', '1.2.3-beta.1', '0.1.0-beta.69']) assert.equal(identity({ ...env, RELEASE_VERSION: version }).version, version);
  for (const version of ['0.70.1', '0.70.0-rc.1', '0.70.0+build', '0.0.0', '0.070.0', '1.70.0', '0.70', 'v0.70.0']) assert.throws(() => identity({ ...env, RELEASE_VERSION: version }), /Only immutable/, version);
});

test('manifest and receipt are bound to independent dispatch identity', () => {
  validateManifest(manifest, expected); validateReceipt(receipt, expected);
  for (const changed of [{ name: '@jc_stack/other' }, { version: '1.2.3' }, { private: true }, { repository: 'https://github.com/attacker/repo' }, { publishConfig: { tag: 'beta' } }, { publishConfig: { access: 'restricted' } }, { publishConfig: { registry: 'https://evil.example/' } }, { publishConfig: { provenance: false } }]) assert.throws(() => validateManifest({ ...manifest, ...changed }, expected));
  for (const changed of [{ repository: 'jdorado/other' }, { sourceSha: 'b'.repeat(40) }, { sha256: '0'.repeat(64) }, { independentReviewUrl: 'https://evil.example/pull/1' }, { independentReviewUrl: 'https://github.com/jdorado/ez-agents/issues/1' }, { testEvidenceUrls: [] }, { testEvidenceUrls: ['https://github.com/jdorado/ez-agents/actions/runs/1/../../evil'] }]) assert.throws(() => validateReceipt({ ...receipt, ...changed }, expected));
});

test('checks cannot pass vacuously, from another app/source or an earlier run', () => {
  validateChecks([check], expected);
  for (const checks of [[], [{ ...check, app: { id: 1 } }], [{ ...check, head_sha: 'b'.repeat(40) }], [{ ...check, conclusion: 'skipped' }], [check, { ...check, id: 2, status: 'in_progress', conclusion: null }]]) assert.throws(() => validateChecks(checks, expected));
});

function sourceApi(overrides = {}) {
  const responses = {
    [runsPath]: { workflow_runs: [mainRun] },
    [jobsPath]: { jobs: [job] },
    [checkPath]: check,
    '/repos/jdorado/ez-agents': { full_name: expected.repository, private: false, visibility: 'public', default_branch: 'main' },
    '/repos/jdorado/ez-agents/contents/docs/plugin-catalog.md?ref=main': { content: Buffer.from('| [Plugin](https://github.com/jdorado/ez-whatsapp) | `@jc_stack/ez-whatsapp` |').toString('base64') },
    '/repos/jdorado/ez-agents/git/ref/heads/main': { object: { sha: expected.sourceSha } },
    [`/repos/jdorado/ez-agents/contents/package.json?ref=${expected.sourceSha}`]: { content: Buffer.from(JSON.stringify(manifest)).toString('base64') },
    [`/repos/jdorado/ez-agents/git/ref/tags/v${expected.version}`]: { object: { type: 'commit', sha: expected.sourceSha } },
    ...overrides,
  };
  return async path => { assert.ok(path in responses, `Unexpected API request ${path}`); if (responses[path] instanceof Error) throw responses[path]; return responses[path]; };
}
const tagPath = `/repos/jdorado/ez-agents/git/ref/tags/v${expected.version}`;
const missingTag = () => Object.assign(new Error(`HTTP 404 while reading GitHub GET ${tagPath}`), { status: 404 });

test('source gates reject private repository, changed main, wrong tag and failed CI', async () => {
  await validateSource(expected, sourceApi());
  for (const override of [
    { '/repos/jdorado/ez-agents': { full_name: expected.repository, private: true, visibility: 'private', default_branch: 'main' } },
    { '/repos/jdorado/ez-agents/git/ref/heads/main': { object: { sha: 'b'.repeat(40) } } },
    { [`/repos/jdorado/ez-agents/git/ref/tags/v${expected.version}`]: { object: { type: 'commit', sha: 'b'.repeat(40) } } },
    { [jobsPath]: { jobs: [] } },
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
  const result = await publishOnce(expected, { readState: async () => reads++ === 0 ? { exists: false, latest: '1.0.0' } : { exists: true, latest: expected.version, beta: 'old' }, publishTarball: async () => { writes++; throw new Error('timeout'); }, sleep: async () => {}, report: () => {} });
  assert.equal(writes, 1); assert.equal(result.status, 'published');
});

test('existing matching publication is read-only; partial or changed tag never republished', async () => {
  let writes = 0;
  const options = { readState: async () => ({ exists: true, latest: expected.version }), publishTarball: async () => { writes++; } };
  assert.equal((await publishOnce(expected, options)).status, 'already-published');
  await assert.rejects(publishOnce(expected, { ...options, readState: async () => ({ exists: true, latest: 'other' }) }), /reconcile/);
  assert.equal(writes, 0);
  for (const after of [{ exists: true, latest: 'changed', beta: expected.version }, { exists: true, latest: '1.0.0', beta: 'other' }, { exists: false, latest: '1.0.0' }]) {
    let reads = 0;
    await assert.rejects(publishOnce(expected, { readState: async () => reads++ === 0 ? { exists: false, latest: '1.0.0' } : after, publishTarball: async () => { writes++; }, sleep: async () => {}, report: () => {} }), /do not repeat/);
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
  assert.equal((await publishOnce(expected, { ...options, readState: async () => ({ exists: true, latest: expected.version }) })).status, 'already-published');
  assert.equal(writes, 0);
});

test('write-started receipt precedes publication and readback records partial failures', async () => {
  const events = []; let read = 0;
  await assert.rejects(publishOnce(expected, { readState: async () => read++ === 0 ? { exists: false, latest: '1' } : { exists: false, latest: '1' }, record: async event => events.push(event), publishTarball: async () => { assert.equal(events.at(-1).phase, 'write-started'); throw new Error('timeout'); }, sleep: async () => {}, report: () => {} }), /unresolved/);
  assert.equal(events[0].phase, 'preflight');
  assert.ok(events.some(event => event.phase === 'readback' && event.publishCommandFailed));
});

test('required check workflow must be main push CI, not a same-named alternate workflow', async () => {
  for (const changed of [{ event: 'pull_request' }, { head_branch: 'feature' }, { path: '.github/workflows/unrelated.yml' }, { conclusion: 'failure' }, { head_sha: 'b'.repeat(40) }]) {
    await assert.rejects(validateSource(expected, sourceApi({ [runsPath]: { workflow_runs: [{ ...mainRun, ...changed }] } })), /main push CI/);
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
  const matrixChecks = ['test (ubuntu-latest, 22)', 'test (macos-latest, 24)', 'docker'];
  assert.ok(generateCaller({ ...config, checks: matrixChecks }).includes(`required-checks: '${JSON.stringify(matrixChecks)}'`));
  assert.ok(generateCaller({ ...config, repository: 'jdorado/ez-agents', packageName: '@jc_stack/ez-agents' }).includes('uses: ./.github/workflows/npm-beta-shared.yml'));
  for (const invalid of [{ repository: "jdorado/repo'\nsteps:" }, { packageName: "@jc_stack/p'\nsteps:" }, { publisherSha: 'main' }, { checks: ['a\nsteps:'] }, { checks: [] }]) assert.throws(() => generateCaller({ ...config, ...invalid }));
});

test('npm publication disables transport retries and scripts, using the explicit latest tag', async () => {
  const { publishArguments } = await import('../scripts/trusted-beta.mjs');
  const args = publishArguments('/candidate.tgz', '/user-npmrc', '/global-npmrc');
  assert.ok(args.includes('--fetch-retries=0'));
  assert.ok(args.includes('--ignore-scripts'));
  assert.equal(args[args.indexOf('--tag') + 1], 'latest');
  assert.equal(args[args.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
  assert.notEqual(args[args.indexOf('--userconfig') + 1], args[args.indexOf('--globalconfig') + 1]);
});


test('newer same-SHA tag, PR and alternate workflow runs cannot shadow main CI', async () => {
  for (const changed of [{ head_branch: 'v1.2.3-beta.1' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) }]) {
    await validateSource(expected, sourceApi({
      [runsPath]: { workflow_runs: [mainRun, { ...mainRun, id: 124, ...changed }] },
    }));
  }
});

test('latest eligible main CI cannot fall back to older success or missing checks', async () => {
  for (const changed of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }, { status: 'queued', conclusion: null }]) {
    await assert.rejects(validateSource(expected, sourceApi({
      [runsPath]: { workflow_runs: [mainRun, { ...mainRun, id: 124, ...changed }] },
    })), /main push CI/);
  }
  await assert.rejects(validateSource(expected, sourceApi({
    [runsPath]: { workflow_runs: [mainRun, { ...mainRun, id: 124 }] },
    [jobsPath.replace('/123/', '/124/')]: { jobs: [] },
  })), /Missing or ambiguous/);
});

test('latest attempt cannot borrow successful jobs from prior attempts or runs', async () => {
  const attemptPath = jobsPath.replace('/attempts/1/', '/attempts/2/');
  for (const jobs of [[], [job], [{ ...job, run_attempt: 2, run_id: 124 }], [{ ...job, run_attempt: 2, head_sha: 'b'.repeat(40) }], [{ ...job, run_attempt: 2, conclusion: 'failure' }], [{ ...job, run_attempt: 2, status: 'in_progress', conclusion: null }]]) {
    await assert.rejects(validateSource(expected, sourceApi({
      [runsPath]: { workflow_runs: [{ ...mainRun, run_attempt: 2 }] },
      [attemptPath]: { jobs },
    })), /Missing or ambiguous|not successful/);
  }
  await validateSource(expected, sourceApi({
    [runsPath]: { workflow_runs: [{ ...mainRun, run_attempt: 2 }] },
    [attemptPath]: { jobs: [{ ...job, run_attempt: 2 }] },
  }));
});

test('required job and check evidence cannot substitute repository, identity or outcomes', async () => {
  for (const changed of [{ check_run_url: job.check_run_url.replace('jdorado/ez-agents', 'attacker/ez-agents') }, { check_run_url: job.check_run_url + '/extra' }, { check_run_url: undefined }, { conclusion: 'skipped' }]) {
    await assert.rejects(validateSource(expected, sourceApi({ [jobsPath]: { jobs: [{ ...job, ...changed }] } })));
  }
  for (const changed of [{ details_url: check.details_url.replace('/123/', '/124/') }, { details_url: undefined }, { name: 'other' }, { app: { id: 1 } }, { head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }]) {
    await assert.rejects(validateSource(expected, sourceApi({ [checkPath]: { ...check, ...changed } })));
  }
  await assert.rejects(validateSource(expected, sourceApi({ [jobsPath]: { jobs: [job, job] } })), /ambiguous/);
});

test('workflow runs and attempt jobs are paginated before selecting required evidence', async () => {
  await validateSource(expected, sourceApi({
    [runsPath]: { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ ...mainRun, id: i + 200, event: 'pull_request' })) },
    [runsPath.replace('&page=1', '&page=2')]: { workflow_runs: [mainRun] },
    [jobsPath]: { jobs: Array.from({ length: 100 }, (_, i) => ({ ...job, name: `other-${i}` })) },
    [jobsPath.replace('&page=1', '&page=2')]: { jobs: [job] },
  }));
});

test('GitHub errors identify the failed read without exposing credentials or signed URLs', async () => {
  const missing = githubClient('private-token', async () => new Response('private-body', { status: 404 }));
  await assert.rejects(missing('/repos/jdorado/ez-agents/git/ref/tags/v1.2.3-beta.1'), error => {
    assert.match(error.message, /HTTP 404.*GitHub GET .*\/git\/ref\/tags\/v1\.2\.3-beta\.1/);
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(missing('/repos/jdorado/ez-agents/releases/123'), error => {
    assert.match(error.message, /HTTP 404.*GitHub GET .*\/releases\/123/);
    assert.doesNotMatch(error.message, /private-token|private-body/);
    return true;
  });
  let request = 0;
  const download = githubClient('private-token', async () => request++ === 0
    ? new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?signature=private-signature' } })
    : new Response('private-body', { status: 403 }));
  await assert.rejects(download('/repos/jdorado/ez-agents/releases/assets/456', true), error => {
    assert.match(error.message, /HTTP 403.*\/releases\/assets\/456 asset download/);
    assert.doesNotMatch(error.message, /private-token|private-body|private-signature|signature=/);
    return true;
  });
});

test('staging validation creates the missing tag only after every other check passes', async t => {
  const { validate } = await import('../scripts/trusted-beta.mjs');
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'beta-staging-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'package'));
  await writeFile(join(dir, 'package/package.json'), JSON.stringify(manifest));
  execFileSync('tar', ['-czf', join(dir, 'candidate.tgz'), '-C', dir, 'package/package.json']);
  const bytes = await readFile(join(dir, 'candidate.tgz'));
  const candidateEnv = { ...env, RELEASE_SHA256: sha256(bytes) };
  let tagExists = false, assetName = 'jc_stack-ez-agents-1.2.3-beta.1.tgz';
  const created = [], reads = [];
  const source = sourceApi();
  const api = async path => {
    reads.push(path);
    if (path.includes('/git/ref/tags/') && !tagExists) return githubClient('test', async () => new Response('', { status: 404 }))(path);
    if (path.endsWith('/releases/123')) return { id: 123, draft: true, prerelease: true, tag_name: `v${expected.version}`, assets: [
      { id: 456, name: assetName, state: 'uploaded' }, { id: 457, name: 'release-receipt.json', state: 'uploaded' },
    ] };
    if (path.endsWith('/releases/assets/456')) return bytes;
    if (path.endsWith('/releases/assets/457')) return Buffer.from(JSON.stringify({ ...receipt, sha256: candidateEnv.RELEASE_SHA256 }));
    if (path.endsWith('/pulls/41')) return { merged: true, base: { repo: { full_name: expected.repository }, ref: 'main' }, merge_commit_sha: expected.sourceSha };
    return source(path);
  };
  const createTag = async value => { created.push(value); tagExists = true; };
  const output = join(dir, 'validated');
  // A draft with a wrong asset name or digest fails before anything is written to GitHub.
  await assert.rejects(validate(output, candidateEnv, api, createTag), /Missing or ambiguous asset: candidate.tgz/);
  assetName = 'candidate.tgz';
  await assert.rejects(validate(output, { ...candidateEnv, RELEASE_SHA256: '0'.repeat(64) }, api, createTag), /SHA256 mismatch/);
  assert.deepEqual(created, []);
  assert.equal(tagExists, false);
  const result = await validate(output, candidateEnv, api, createTag);
  assert.equal(result.sha256, sha256(bytes));
  assert.deepEqual(await readFile(join(output, 'candidate.tgz')), bytes);
  // One tag, at the dispatched source, created by the validated identity.
  assert.deepEqual(created.map(({ repository, version, sourceSha }) => ({ repository, version, sourceSha })), [{ repository: expected.repository, version: expected.version, sourceSha: expected.sourceSha }]);
  // Retry cannot silently replace an existing validated bundle, and never recreates the tag.
  await assert.rejects(validate(output, candidateEnv, api, createTag), /EEXIST/);
  assert.equal(created.length, 1);
});

test('release tag is created once when absent and never moved when present', async () => {
  const created = [];
  let current = null;
  const api = async path => {
    assert.equal(path, tagPath);
    if (current === null) throw missingTag();
    return { object: current };
  };
  const createTag = async value => { created.push(value); current = { type: 'commit', sha: expected.sourceSha }; };
  await ensureTag(expected, api, createTag);
  assert.equal(created.length, 1);
  await ensureTag(expected, api, createTag);
  assert.equal(created.length, 1);
  // An existing tag is accepted only at the source, including an annotated tag that peels to it.
  const annotated = async path => path === tagPath ? { object: { type: 'tag', sha: 'c'.repeat(40) } } : { object: { type: 'commit', sha: expected.sourceSha } };
  await ensureTag(expected, annotated, createTag);
  for (const object of [{ type: 'commit', sha: 'b'.repeat(40) }, { type: 'tree', sha: expected.sourceSha }]) {
    await assert.rejects(ensureTag(expected, async () => ({ object }), createTag), /does not identify approved source/);
  }
  assert.equal(created.length, 1);
});

test('missing release tag fails closed without a creator, on a failed read, or when creation does not take effect', async () => {
  const writes = [];
  const createTag = async value => { writes.push(value); };
  await assert.rejects(validateSource(expected, sourceApi({ [tagPath]: missingTag() })), /Release tag v1\.2\.3-beta\.1 is missing/);
  // Server and permission failures are not "missing": nothing is created.
  await assert.rejects(ensureTag(expected, async () => { throw Object.assign(new Error('HTTP 500'), { status: 500 }); }, createTag), /HTTP 500/);
  await assert.rejects(ensureTag(expected, async () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }); }, createTag), /HTTP 403/);
  assert.equal(writes.length, 0);
  // A creator that returns without a tag appearing, or a racing tag at another commit, is rejected.
  await assert.rejects(ensureTag(expected, async () => { throw missingTag(); }, createTag), /was not created/);
  let raced = false;
  await assert.rejects(ensureTag(expected, async () => { if (!raced) throw missingTag(); return { object: { type: 'commit', sha: 'b'.repeat(40) } }; }, async () => { raced = true; }), /does not identify approved source/);
});

test('tag creation is one POST of a lightweight ref and tolerates only an already-existing ref', async () => {
  const requests = [];
  const creator = status => githubTagCreator('private-token', async (url, options) => { requests.push({ url: String(url), options }); return new Response('private-body', { status }); });
  await creator(201)(expected);
  await creator(422)(expected);
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(url, 'https://api.github.com/repos/jdorado/ez-agents/git/refs');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { ref: `refs/tags/v${expected.version}`, sha: expected.sourceSha });
    assert.equal(options.headers.Authorization, 'Bearer private-token');
  }
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(creator(status)(expected), error => {
      assert.match(error.message, new RegExp(`HTTP ${status} while creating release tag v1\\.2\\.3-beta\\.1`));
      assert.doesNotMatch(error.message, /private-token|private-body/);
      return true;
    });
  }
});

test('readback waits for slow registry visibility within a bounded window and writes once', async () => {
  const delays = readbackDelays();
  assert.equal(delays[0], 5000);
  assert.ok(delays.every((delay, i) => delay <= 30_000 && (i === 0 || delay >= delays[i - 1])));
  const budget = delays.reduce((sum, delay) => sum + delay, 0);
  assert.ok(budget >= 5 * 60_000 && budget <= 10 * 60_000, `readback window is ${budget} ms`);
  for (const visibleAt of [0, 1, 3, delays.length]) {
    let writes = 0, reads = 0; const waits = [], events = [];
    const result = await publishOnce(expected, {
      readState: async () => reads++ > visibleAt ? { exists: true, latest: expected.version } : { exists: false, latest: '1.0.0' },
      publishTarball: async () => { writes++; },
      sleep: async ms => { waits.push(ms); }, record: async event => events.push(event.phase), report: () => {},
    });
    assert.deepEqual(result, { status: 'published', version: expected.version, sha256: expected.sha256 });
    assert.equal(writes, 1);
    assert.deepEqual(waits, delays.slice(0, visibleAt));
    assert.equal(events.filter(phase => phase === 'readback').length, visibleAt + 1);
  }
});

test('readback that never verifies fails closed after the bounded window without a second write', async () => {
  const delays = readbackDelays();
  for (const after of [{ exists: false, latest: '1.0.0' }, { exists: true, latest: '1.0.0' }, 'error']) {
    let writes = 0, reads = 0; const waits = [];
    await assert.rejects(publishOnce(expected, {
      readState: async () => { if (reads++ === 0) return { exists: false, latest: '1.0.0' }; if (after === 'error') throw new Error('registry unavailable'); return after; },
      publishTarball: async () => { writes++; },
      sleep: async ms => { waits.push(ms); }, record: async () => {}, report: () => {},
    }), /Publication unresolved; do not repeat the write/);
    assert.equal(writes, 1);
    assert.deepEqual(waits, delays);
    assert.equal(reads, delays.length + 2);
  }
});

test('transient readback errors are retried but different registry bytes fail at once', async () => {
  let reads = 0, writes = 0; const waits = [];
  const flaky = await publishOnce(expected, {
    readState: async () => { reads++; if (reads === 1) return { exists: false, latest: '1.0.0' }; if (reads < 4) throw new Error('HTTP 503 while reading registry'); return { exists: true, latest: expected.version }; },
    publishTarball: async () => { writes++; }, sleep: async ms => { waits.push(ms); }, record: async () => {}, report: () => {},
  });
  assert.equal(flaky.status, 'published'); assert.equal(writes, 1); assert.equal(waits.length, 2);
  // A registry whose tarball digest differs is final: no waiting, no second write.
  const document = { name: expected.package, versions: {}, 'dist-tags': { latest: '1.0.0' } };
  const published = { ...manifest, dist: { tarball: 'https://registry.npmjs.org/file.tgz' } };
  let calls = 0; waits.length = 0; writes = 0;
  const events = [];
  const readState = () => {
    if (calls++ === 0) return registryState(expected, async () => new Response(JSON.stringify(document)));
    let n = 0;
    return registryState(expected, async () => n++ === 0 ? new Response(JSON.stringify({ ...document, versions: { [expected.version]: published } })) : new Response('changed'));
  };
  await assert.rejects(publishOnce(expected, { readState, publishTarball: async () => { writes++; }, sleep: async ms => { waits.push(ms); }, record: async event => events.push(event.phase), report: () => {} }), /Publication unresolved.*differs/);
  assert.equal(writes, 1); assert.deepEqual(waits, []);
  assert.ok(events.includes('readback-error'));
});

const publicationBytes = (status = 'published', events = []) => Buffer.from(JSON.stringify({ schema: 1, expected, events: [{ phase: 'preflight' }, ...events, { phase: 'complete', result: { status, version: expected.version, sha256: expected.sha256 } }] }, null, 2) + '\n');
const receiptBytes = publicationBytes();
const sumsBytes = Buffer.from(`${expected.sha256}  candidate.tgz\n`);
const candidateBytes = Buffer.from('candidate');

// A stateful fake of the draft release and its two writes; `writes` records every attempted GitHub write in order.
function fakeRelease({ draft = true, assets = [], tag = { type: 'commit', sha: expected.sourceSha }, release = {}, failUpload = false, stayDraft = false, dropUploads = false } = {}) {
  const state = { reads: [], writes: [], tag, bytes: {}, release: { id: 123, draft, prerelease: true, tag_name: `v${expected.version}`, assets: [], ...release } };
  let next = 100;
  const add = (name, bytes, extra = {}) => { const asset = { id: ++next, name, state: 'uploaded', ...extra }; state.release.assets.push(asset); state.bytes[asset.id] = bytes; return asset; };
  add('candidate.tgz', candidateBytes); add('release-receipt.json', Buffer.from('{}'));
  for (const [name, bytes, extra] of assets) add(name, bytes, extra);
  const api = async (path, binary) => {
    state.reads.push(path);
    if (path === tagPath) { if (!state.tag) throw missingTag(); return { object: state.tag }; }
    if (path === '/repos/jdorado/ez-agents/releases/123') return structuredClone(state.release);
    const match = path.match(/^\/repos\/jdorado\/ez-agents\/releases\/assets\/(\d+)$/);
    assert.ok(match && binary, `Unexpected API request ${path}`);
    return state.bytes[match[1]];
  };
  const writer = {
    upload: async (value, name, { type, bytes }) => {
      assert.deepEqual(value, expected); state.writes.push(`upload ${name}`);
      if (failUpload) throw new Error('HTTP 502 while uploading release asset');
      if (!dropUploads) add(name, bytes);
      state.uploaded = { ...state.uploaded, [name]: { type, bytes } };
    },
    publish: async value => { assert.deepEqual(value, expected); state.writes.push('publish'); if (!stayDraft) state.release.draft = false; },
  };
  return { state, api, writer };
}
const finishWith = (fake, bytes = receiptBytes) => finishRelease(expected, bytes, fake);

test('publication receipt counts only when complete for this exact dispatch', () => {
  publicationReceipt(receiptBytes, expected);
  publicationReceipt(publicationBytes('already-published'), expected);
  const complete = { phase: 'complete', result: { status: 'published', version: expected.version, sha256: expected.sha256 } };
  const receiptWith = change => Buffer.from(JSON.stringify({ schema: 1, expected, events: [{ phase: 'preflight' }, complete], ...change }));
  for (const bytes of [
    Buffer.from('not json'), Buffer.from('null'), Buffer.alloc(1024 * 1024 + 1),
    receiptWith({ schema: 2 }), receiptWith({ expected: { ...expected, sourceSha: 'b'.repeat(40) } }), receiptWith({ expected: { ...expected, releaseId: 124 } }),
    receiptWith({ events: undefined }), receiptWith({ events: [] }),
    receiptWith({ events: [{ phase: 'write-started' }] }), receiptWith({ events: [{ phase: 'readback', after: { exists: true, latest: expected.version } }] }),
    receiptWith({ events: [complete, { phase: 'failed', error: 'late' }] }),
    receiptWith({ events: [{ ...complete, result: { ...complete.result, status: 'unresolved' } }] }),
    receiptWith({ events: [{ ...complete, result: { ...complete.result, version: '9.9.9' } }] }),
    receiptWith({ events: [{ ...complete, result: { ...complete.result, sha256: '0'.repeat(64) } }] }),
  ]) assert.throws(() => publicationReceipt(bytes, expected));
});

test('finish adds the checksum and receipt, then publishes the draft as a prerelease, in that order', async () => {
  const fake = fakeRelease();
  const result = await finishWith(fake);
  assert.deepEqual(result, { status: 'finished', version: expected.version, sha256: expected.sha256 });
  assert.deepEqual(fake.state.writes, ['upload SHA256SUMS', 'upload publication-receipt.json', 'publish']);
  // The uploaded checksum file verifies the candidate asset and the receipt is the publish job's own file.
  assert.deepEqual(fake.state.uploaded['SHA256SUMS'], { type: 'application/octet-stream', bytes: sumsBytes });
  assert.equal(sha256(candidateBytes), sumsBytes.toString().split('  ')[0]);
  assert.deepEqual(fake.state.uploaded['publication-receipt.json'], { type: 'application/json', bytes: receiptBytes });
  assert.equal(fake.state.release.draft, false);
  assert.equal(fake.state.release.prerelease, true);
});

test('finish is a no-op on a finished release and continues an interrupted one without replacing anything', async () => {
  const done = fakeRelease();
  await finishWith(done);
  const before = done.state.writes.length;
  // A rerun may carry a different but valid receipt (for example already-published); the existing one stays.
  for (const bytes of [receiptBytes, publicationBytes('already-published', [{ phase: 'readback' }])]) {
    assert.equal((await finishWith(done, bytes)).status, 'already-finished');
  }
  assert.equal(done.state.writes.length, before);
  const cases = [
    { name: 'checksum already uploaded', assets: [['SHA256SUMS', sumsBytes]], writes: ['upload publication-receipt.json', 'publish'] },
    { name: 'both assets uploaded, still a draft', assets: [['SHA256SUMS', sumsBytes], ['publication-receipt.json', receiptBytes]], writes: ['publish'] },
    { name: 'published by hand without a receipt', draft: false, assets: [['SHA256SUMS', sumsBytes]], writes: ['upload publication-receipt.json'] },
    { name: 'published by hand without any asset', draft: false, assets: [], writes: ['upload SHA256SUMS', 'upload publication-receipt.json'] },
  ];
  for (const { name, writes, ...options } of cases) {
    const fake = fakeRelease(options);
    assert.equal((await finishWith(fake)).status, 'finished', name);
    assert.deepEqual(fake.state.writes, writes, name);
    assert.equal(fake.state.release.draft, false, name);
  }
});

test('finish fails closed before writing anything when the release, tag, bytes or assets do not match', async () => {
  const wrongReceipt = Buffer.from(JSON.stringify({ schema: 1, expected: { ...expected, sourceSha: 'b'.repeat(40) }, events: [] }));
  const cases = {
    'candidate bytes changed': { mutate: state => { state.bytes[101] = Buffer.from('replaced'); } },
    'candidate missing': { mutate: state => { state.release.assets = state.release.assets.filter(asset => asset.name !== 'candidate.tgz'); } },
    'candidate partially uploaded': { mutate: state => { state.release.assets[0].state = 'starter'; } },
    'tag missing': { options: { tag: null } },
    'tag at another commit': { options: { tag: { type: 'commit', sha: 'b'.repeat(40) } } },
    'not a prerelease': { options: { release: { prerelease: false } } },
    'another release tag': { options: { release: { tag_name: 'v9.9.9' } } },
    'another release id': { options: { release: { id: 124 } } },
    'unknown draft state': { options: { release: { draft: undefined } } },
    'checksum differs': { options: { assets: [['SHA256SUMS', Buffer.from(`${'0'.repeat(64)}  candidate.tgz\n`)]] } },
    'checksum partially uploaded': { options: { assets: [['SHA256SUMS', sumsBytes, { state: 'starter' }]] } },
    'receipt for another dispatch': { options: { assets: [['publication-receipt.json', wrongReceipt]] } },
    'duplicate checksum': { options: { assets: [['SHA256SUMS', sumsBytes], ['SHA256SUMS', sumsBytes]] } },
  };
  for (const [name, { options, mutate }] of Object.entries(cases)) {
    const fake = fakeRelease(options);
    mutate?.(fake.state);
    await assert.rejects(finishWith(fake), undefined, name);
    assert.deepEqual(fake.state.writes, [], name);
  }
  // An invalid receipt stops before the first GitHub read.
  const fake = fakeRelease();
  for (const bytes of [Buffer.from('{}'), publicationBytes('unresolved')]) await assert.rejects(finishWith(fake, bytes), /Publication receipt/);
  assert.deepEqual(fake.state.reads, []);
});

test('finish never publishes after a failed upload and rejects an unconfirmed readback', async () => {
  const failed = fakeRelease({ failUpload: true });
  await assert.rejects(finishWith(failed), /HTTP 502/);
  assert.deepEqual(failed.state.writes, ['upload SHA256SUMS']);
  const stuck = fakeRelease({ stayDraft: true });
  await assert.rejects(finishWith(stuck), /still a draft/);
  const dropped = fakeRelease({ draft: false, dropUploads: true });
  await assert.rejects(finishWith(dropped), /incomplete/);
  const swapped = fakeRelease();
  const publish = swapped.writer.publish;
  swapped.writer.publish = async value => { await publish(value); swapped.state.release.assets[0].id = 999; };
  await assert.rejects(finishWith(swapped), /changed during publication/);
});

test('release writer makes only one POST upload per asset and one PATCH publish, and reports failures without secrets', async () => {
  const requests = [];
  const writer = status => githubReleaseWriter('private-token', async (url, options) => { requests.push({ url: String(url), options }); return new Response('private-body', { status }); });
  await writer(201).upload(expected, 'SHA256SUMS', { type: 'application/octet-stream', bytes: sumsBytes });
  await writer(200).publish(expected);
  assert.deepEqual(requests.map(({ url, options }) => [options.method, url]), [
    ['POST', 'https://uploads.github.com/repos/jdorado/ez-agents/releases/123/assets?name=SHA256SUMS'],
    ['PATCH', 'https://api.github.com/repos/jdorado/ez-agents/releases/123'],
  ]);
  assert.equal(requests[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(requests[0].options.body, sumsBytes);
  assert.deepEqual(JSON.parse(requests[1].options.body), { draft: false, prerelease: true, make_latest: 'false' });
  for (const { options } of requests) { assert.equal(options.headers.Authorization, 'Bearer private-token'); assert.equal(options.redirect, 'manual'); }
  for (const status of [200, 401, 403, 404, 422, 500]) {
    await assert.rejects(writer(status).upload(expected, 'SHA256SUMS', { type: 'text/plain', bytes: sumsBytes }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status} while uploading release asset SHA256SUMS`));
      assert.doesNotMatch(error.message, /private-token|private-body/);
      return true;
    });
  }
  for (const status of [201, 401, 403, 404, 422, 500]) {
    await assert.rejects(writer(status).publish(expected), error => {
      assert.match(error.message, new RegExp(`HTTP ${status} while publishing release v1\\.2\\.3-beta\\.1`));
      assert.doesNotMatch(error.message, /private-token|private-body/);
      return true;
    });
  }
});

test('finish entry point reads the receipt the publish job preserved and needs the dispatch identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beta-finish-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = fakeRelease();
  // No receipt, or a push-triggered run, fails before any GitHub read.
  await assert.rejects(finish(dir, env, fake.api, fake.writer), /ENOENT/);
  await writeFile(join(dir, 'publication-receipt.json'), receiptBytes);
  await assert.rejects(finish(dir, { ...env, GITHUB_EVENT_NAME: 'push' }, fake.api, fake.writer), /manually dispatch/);
  assert.deepEqual(fake.state.reads, []);
  assert.equal((await finish(dir, env, fake.api, fake.writer)).status, 'finished');
  assert.deepEqual(fake.state.writes, ['upload SHA256SUMS', 'upload publication-receipt.json', 'publish']);
});

test('only the finish job after publish can write the release, with no OIDC and no npm publish', async () => {
  const workflow = await readFile(new URL('../.github/workflows/npm-beta-shared.yml', import.meta.url), 'utf8');
  const jobs = {}; let current;
  for (const line of workflow.slice(workflow.indexOf('\njobs:\n')).split('\n').slice(2)) {
    const name = line.match(/^ {2}([a-z][a-z-]*):$/)?.[1];
    if (name) jobs[current = name] = ''; else if (current) jobs[current] += line + '\n';
  }
  const permissions = block => Object.fromEntries([...block.matchAll(/^ {6}([a-z-]+): (read|write)$/gm)].map(match => [match[1], match[2]]));
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.deepEqual(Object.keys(jobs), ['validate', 'publish', 'finish']);
  assert.equal(permissions(jobs.validate).contents, 'write');
  assert.deepEqual(permissions(jobs.publish), { contents: 'read', actions: 'read', checks: 'read', 'id-token': 'write' });
  assert.deepEqual(permissions(jobs.finish), { contents: 'write', actions: 'read' });
  assert.match(jobs.publish, /^ {4}needs: validate$/m);
  assert.match(jobs.finish, /^ {4}needs: publish$/m);
  assert.doesNotMatch(jobs.finish, /id-token|NODE_AUTH_TOKEN|npm |trusted-beta\.mjs (?:validate|publish)/);
  assert.match(jobs.finish, /trusted-beta\.mjs finish "\$RUNNER_TEMP\/readback"/);
  assert.doesNotMatch(jobs.validate + jobs.publish, /trusted-beta\.mjs finish/);
  assert.match(jobs.finish, /persist-credentials: false/);
  // The finish job reads the receipt the publish job preserved, by immutable artifact ID.
  assert.match(jobs.publish, /readback-artifact-id: \$\{\{ steps\.readback\.outputs\.artifact-id \}\}/);
  assert.match(jobs.finish, /artifact-ids: \$\{\{ needs\.publish\.outputs\.readback-artifact-id \}\}/);
});
