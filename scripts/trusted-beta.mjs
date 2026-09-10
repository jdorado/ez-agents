#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org/';
const CORE = 'jdorado/ez-agents';
const MAX_ARTIFACT = 100 * 1024 * 1024;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function publishEnvironment(env) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI',
    'GITHUB_ACTIONS', 'GITHUB_WORKFLOW', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA',
    'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_REPOSITORY_OWNER_ID',
    'GITHUB_SERVER_URL', 'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_REF_TYPE', 'GITHUB_SHA',
    'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT', 'GITHUB_EVENT_NAME', 'GITHUB_JOB',
    'GITHUB_ACTOR', 'GITHUB_ACTOR_ID', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  return Object.fromEntries(allowed.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

export function publishArguments(path, npmrc, globalNpmrc) {
  return ['publish', path, '--fetch-retries=0', '--ignore-scripts', '--provenance', '--access', 'public', '--tag', 'latest', '--registry', REGISTRY, '--userconfig', npmrc, '--globalconfig', globalNpmrc];
}

export function identity(env) {
  const value = { repository: env.RELEASE_REPOSITORY, package: env.RELEASE_PACKAGE,
    version: env.RELEASE_VERSION, sourceSha: env.RELEASE_SOURCE_SHA,
    sha256: env.RELEASE_SHA256, releaseId: Number(env.RELEASE_ID), requiredChecks: JSON.parse(env.RELEASE_REQUIRED_CHECKS || 'null') };
  assert(/^[1-9]\d*$/.test(env.RELEASE_ID || '') && Number.isSafeInteger(value.releaseId), 'Invalid draft release ID');
  assert(/^jdorado\/[A-Za-z0-9_.-]+$/.test(value.repository || ''), 'Invalid repository');
  assert(/^@jc_stack\/[a-z0-9-]+$/.test(value.package || ''), 'Invalid package');
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.test(value.version || ''), 'Only immutable beta.N versions are allowed');
  assert(/^[a-f0-9]{40}$/.test(value.sourceSha || ''), 'Invalid source SHA');
  assert(/^[a-f0-9]{64}$/.test(value.sha256 || ''), 'Invalid artifact SHA256');
  assert(Array.isArray(value.requiredChecks) && value.requiredChecks.length > 0 && value.requiredChecks.every(x => typeof x === 'string' && x.length > 0) && new Set(value.requiredChecks).size === value.requiredChecks.length, 'Required checks must be a nonempty unique list');
  assert(env.GITHUB_REPOSITORY === value.repository, 'Caller repository mismatch');
  assert(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'Must manually dispatch from main');
  assert(env.GITHUB_SHA === value.sourceSha, 'Source must equal dispatched source');
  return value;
}

export function validateManifest(manifest, expected) {
  assert(manifest.name === expected.package && manifest.version === expected.version, 'Package identity mismatch');
  assert(manifest.private !== true, 'Private packages cannot be published');
  const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  assert(repo === `git+https://github.com/${expected.repository}.git` || repo === `https://github.com/${expected.repository}.git` || repo === `https://github.com/${expected.repository}`, 'Package repository mismatch');
  const config = manifest.publishConfig || {};
  assert(Object.keys(config).every(key => ['access', 'tag', 'registry', 'provenance'].includes(key)), 'Unsupported publish configuration');
  assert(config.access === undefined || config.access === 'public', 'Invalid publish access');
  assert(config.tag === undefined || config.tag === 'latest', 'Invalid publish tag');
  assert(config.registry === undefined || config.registry === REGISTRY || config.registry === REGISTRY.slice(0, -1), 'Invalid publish registry');
  assert(config.provenance !== false, 'Provenance must not be disabled');
}

export function validateReceipt(receipt, expected) {
  for (const key of ['repository', 'package', 'version', 'sourceSha', 'sha256']) {
    assert(receipt[key] === expected[key], `Receipt ${key} mismatch`);
  }
  const base = `https://github.com/${expected.repository}/`;
  assert(typeof receipt.independentReviewUrl === 'string' && receipt.independentReviewUrl.startsWith(base) && /^pull\/[1-9]\d*(?:#[A-Za-z0-9_-]+)?$/.test(receipt.independentReviewUrl.slice(base.length)), 'Missing independent review PR URL');
  assert(Array.isArray(receipt.testEvidenceUrls) && receipt.testEvidenceUrls.length > 0 && receipt.testEvidenceUrls.every(url => typeof url === 'string' && url.startsWith(base) && /^(?:actions\/runs|pull|issues)\/[1-9]\d*(?:#[A-Za-z0-9_-]+)?$/.test(url.slice(base.length))), 'Missing test evidence URLs');
}

export function validateChecks(checks, expected) {
  const selected = [];
  for (const name of expected.requiredChecks) {
    const runs = checks.filter(check => check.name === name && check.head_sha === expected.sourceSha && check.app?.id === 15368).sort((a, b) => b.id - a.id);
    assert(runs.length > 0 && runs[0].status === 'completed' && runs[0].conclusion === 'success', `Required GitHub Actions check not successful: ${name}`);
    selected.push(runs[0]);
  }
  return selected;
}

export function tarManifest(path) {
  const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 };
  const entries = execFileSync('tar', ['-tzf', path], options).trim().split('\n');
  assert(entries.filter(name => name === 'package/package.json').length === 1, 'Tarball must have exactly one package/package.json');
  assert(entries.every(name => name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\')), 'Unsafe tarball path');
  const details = execFileSync('tar', ['-tvzf', path], options).trim().split('\n');
  assert(details.every(line => line.startsWith('-') || line.startsWith('d')), 'Tarball links or special files are forbidden');
  return JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { ...options, maxBuffer: 1024 * 1024 }));
}

async function responseBytes(response, max = MAX_ARTIFACT) {
  assert(response.ok, `HTTP ${response.status} while reading release evidence`);
  assert(Number(response.headers.get('content-length') || 0) <= max, 'Response too large');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; assert(size <= max, 'Response too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function githubClient(token, fetcher = fetch) {
  return async (path, binary = false) => {
    assert(path.startsWith('/repos/'), 'Invalid GitHub API path');
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    if (binary && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = new URL(response.headers.get('location'));
      assert(location.protocol === 'https:' && (location.hostname === 'release-assets.githubusercontent.com' || location.hostname === 'objects.githubusercontent.com'), 'Unexpected asset redirect');
      return responseBytes(await fetcher(location, { signal: AbortSignal.timeout(60_000), redirect: 'error' }));
    }
    const bytes = await responseBytes(response, binary ? MAX_ARTIFACT : 8 * 1024 * 1024);
    return binary ? bytes : JSON.parse(bytes.toString());
  };
}

export async function validateSource(expected, api) {
  const repo = await api(`/repos/${expected.repository}`);
  assert(repo.full_name === expected.repository && repo.private === false && repo.visibility === 'public' && repo.default_branch === 'main' && !repo.archived, 'Repository must be public and active on main');
  const catalog = await api(`/repos/${CORE}/contents/docs/plugin-catalog.md?ref=main`);
  const catalogText = Buffer.from(catalog.content, 'base64').toString('utf8');
  const enrolled = catalogText.split('\n').some(line => line.startsWith('|') && line.includes(`](https://github.com/${expected.repository})`) && line.includes('`' + expected.package + '`'));
  assert(expected.repository === CORE ? expected.package === '@jc_stack/ez-agents' : enrolled, 'Repository/package is not enrolled in public catalog');
  const main = await api(`/repos/${expected.repository}/git/ref/heads/main`);
  assert(main.object?.sha === expected.sourceSha, 'Source is no longer current main');
  const manifest = await api(`/repos/${expected.repository}/contents/package.json?ref=${expected.sourceSha}`);
  const sourceManifest = JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8'));
  validateManifest(sourceManifest, expected);
  let tag = (await api(`/repos/${expected.repository}/git/ref/tags/v${expected.version}`)).object;
  for (let depth = 0; tag?.type === 'tag' && depth < 5; depth++) tag = (await api(`/repos/${expected.repository}/git/tags/${tag.sha}`)).object;
  assert(tag?.type === 'commit' && tag.sha === expected.sourceSha, 'Release tag does not identify approved source');
  const checks = [];
  for (let page = 1; ; page++) {
    assert(page <= 100, 'Too many check pages');
    const result = await api(`/repos/${expected.repository}/commits/${expected.sourceSha}/check-runs?per_page=100&page=${page}`);
    assert(Array.isArray(result.check_runs), 'Invalid check response');
    checks.push(...result.check_runs);
    if (result.check_runs.length < 100) break;
  }
  for (const check of validateChecks(checks, expected)) {
    const prefix = `https://github.com/${expected.repository}/actions/runs/`;
    assert(typeof check.details_url === 'string' && check.details_url.startsWith(prefix), 'Check does not identify a repository Actions run');
    const match = check.details_url.slice(prefix.length).match(/^([1-9]\d*)\/job\/[1-9]\d*$/);
    assert(match, 'Invalid check run evidence URL');
    const run = await api(`/repos/${expected.repository}/actions/runs/${match[1]}`);
    assert(run.head_sha === expected.sourceSha && run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/ci.yml' && run.status === 'completed' && run.conclusion === 'success', 'Required check is not successful main push CI');
  }
  return sourceManifest;
}

export async function registryState(expected, fetcher = fetch) {
  const response = await fetcher(`${REGISTRY}${encodeURIComponent(expected.package)}`, { signal: AbortSignal.timeout(30_000), redirect: 'error', headers: { Accept: 'application/json' } });
  assert(response.status !== 404, 'Package does not exist: first reviewed beta needs interactive registry-owner publication before trust enrollment');
  const data = JSON.parse((await responseBytes(response, 32 * 1024 * 1024)).toString());
  assert(data.name === expected.package && data.versions && data['dist-tags'], 'Invalid registry package metadata');
  const published = data.versions[expected.version];
  if (!published) return { exists: false, latest: data['dist-tags'].latest ?? null, beta: data['dist-tags'].beta ?? null };
  assert(published.name === expected.package && published.version === expected.version, 'Registry version identity mismatch');
  const url = new URL(published.dist?.tarball);
  assert(url.origin === REGISTRY.slice(0, -1), 'Unexpected registry tarball host');
  const bytes = await responseBytes(await fetcher(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' }));
  assert(sha256(bytes) === expected.sha256, 'Existing registry artifact differs; never overwrite');
  return { exists: true, latest: data['dist-tags'].latest ?? null, beta: data['dist-tags'].beta ?? null };
}

export async function validate(output, env = process.env, api = githubClient(env.GH_TOKEN)) {
  const expected = identity(env);
  const sourceManifest = await validateSource(expected, api);
  const release = await api(`/repos/${expected.repository}/releases/${expected.releaseId}`);
  assert(release.id === expected.releaseId && release.draft === true && release.prerelease === true && release.tag_name === `v${expected.version}`, 'Candidate must be a draft prerelease');
  const asset = name => {
    const matches = (release.assets || []).filter(item => item.name === name && item.state === 'uploaded');
    assert(matches.length === 1 && Number.isSafeInteger(matches[0].id), `Missing or ambiguous asset: ${name}`);
    return matches[0];
  };
  const candidateAsset = asset('candidate.tgz');
  const receiptAsset = asset('release-receipt.json');
  const bytes = await api(`/repos/${expected.repository}/releases/assets/${candidateAsset.id}`, true);
  assert(sha256(bytes) === expected.sha256, 'Candidate artifact SHA256 mismatch');
  const receipt = JSON.parse((await api(`/repos/${expected.repository}/releases/assets/${receiptAsset.id}`, true)).toString());
  validateReceipt(receipt, expected);
  // Dispatch is the authorized maintainer's attestation to these review/test URLs.
  // Their existence alone is not an independent review verdict.
  const reviewPr = Number(new URL(receipt.independentReviewUrl).pathname.split('/')[4]);
  const pr = await api(`/repos/${expected.repository}/pulls/${reviewPr}`);
  assert(pr.merged === true && pr.base?.repo?.full_name === expected.repository && pr.base?.ref === 'main' && pr.merge_commit_sha === expected.sourceSha, 'Review PR must be merged as the exact release source');
  await mkdir(output, { recursive: true });
  const tarball = resolve(output, 'candidate.tgz');
  await writeFile(tarball, bytes, { flag: 'wx' });
  const packedManifest = tarManifest(tarball);
  validateManifest(packedManifest, expected);
  assert(isDeepStrictEqual(packedManifest, sourceManifest), 'Packed manifest differs from approved source manifest');
  await writeFile(resolve(output, 'validated.json'), JSON.stringify({ schema: 1, expected, receipt, releaseId: release.id, candidateAssetId: candidateAsset.id }, null, 2) + '\n', { flag: 'wx' });
  return { sourceSha: expected.sourceSha, sha256: expected.sha256, version: expected.version };
}

export async function publishOnce(expected, { readState, publishTarball, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = console.log, record = async () => {}, allowWrite = true }) {
  const before = await readState();
  await record({ phase: 'preflight', before });
  if (before.exists) {
    assert(before.latest === expected.version, 'Artifact exists but latest tag differs; reconcile without republishing');
    return { status: 'already-published', version: expected.version, sha256: expected.sha256 };
  }
  assert(allowWrite, 'Rerun cannot repeat publication: reconcile registry state and create a fresh authorized dispatch if a new attempt is needed');
  await record({ phase: 'write-started', before });
  let writeError;
  try { await publishTarball(); } catch (error) { writeError = error; }
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(5000);
    try {
      const after = await readState();
      await record({ phase: 'readback', before, after, publishCommandFailed: Boolean(writeError), attempt });
      if (after.exists && after.latest === expected.version) {
        if (writeError) report('Publish command was uncertain; registry readback verified exact artifact and latest tag.');
        return { status: 'published', version: expected.version, sha256: expected.sha256 };
      }
      lastError = new Error('Exact artifact and latest tag not yet verified');
    } catch (error) { lastError = error; await record({ phase: 'readback-error', before, error: error.message, attempt }); }
  }
  throw new Error(`Publication unresolved; do not repeat the write before registry reconciliation: ${lastError?.message || writeError?.message}`);
}

export async function publish(output, env = process.env) {
  const expected = identity(env);
  const bundle = JSON.parse(await readFile(resolve(output, 'validated.json'), 'utf8'));
  assert(bundle.schema === 1 && JSON.stringify(bundle.expected) === JSON.stringify(expected), 'Validated bundle does not match dispatched identity');
  validateReceipt(bundle.receipt, expected);
  const path = resolve(output, 'candidate.tgz');
  assert(sha256(await readFile(path)) === expected.sha256, 'Validated artifact changed');
  const packedManifest = tarManifest(path);
  validateManifest(packedManifest, expected);
  const sourceManifest = await validateSource(expected, githubClient(env.GH_TOKEN));
  assert(isDeepStrictEqual(packedManifest, sourceManifest), 'Packed manifest differs from approved source manifest');
  assert(!env.NODE_AUTH_TOKEN && !env.NPM_TOKEN, 'Token-based npm publishing is forbidden');
  const temporary = await mkdtemp(join(tmpdir(), 'trusted-beta-'));
  try {
    const npmrc = join(temporary, 'npmrc');
    const globalNpmrc = join(temporary, 'global-npmrc');
    await writeFile(npmrc, 'registry=https://registry.npmjs.org/\n');
    await writeFile(globalNpmrc, '');
    const events = [];
    const record = async event => {
      events.push({ at: new Date().toISOString(), ...event });
      const receiptPath = resolve(output, 'publication-receipt.json');
      await writeFile(`${receiptPath}.${process.pid}.tmp`, JSON.stringify({ schema: 1, expected, events }, null, 2) + '\n', { mode: 0o600 });
      await rename(`${receiptPath}.${process.pid}.tmp`, receiptPath);
    };
    try {
      const result = await publishOnce(expected, {
      record,
      allowWrite: env.GITHUB_RUN_ATTEMPT === '1',
      readState: () => registryState(expected),
      publishTarball: () => execFileSync('npm', publishArguments(path, npmrc, globalNpmrc), {
        cwd: temporary, stdio: 'inherit', timeout: 180_000,
        env: publishEnvironment(env),
      }),
    });
      await record({ phase: 'complete', result });
      return result;
    } catch (error) {
      await record({ phase: 'failed', error: error.message });
      throw error;
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, output] = process.argv.slice(2);
    assert(['validate', 'publish'].includes(mode) && output && process.argv.length === 4, 'Usage: trusted-beta.mjs validate|publish OUTPUT_DIR');
    console.log(JSON.stringify(await (mode === 'validate' ? validate(output) : publish(output))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
