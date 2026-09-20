import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { configureInstallation } from '../src/install-config.js'
import { readActiveExecutor } from '../src/setup.js'
import { serviceDefinition } from '../src/service.js'

test('configure preserves custom paths and unknown settings, keeps token private, and never resets the mind', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-configure-'))
  try {
    await writeFile(path.join(root, '.env'), 'EZ_AGENT_WORKSPACE="my mind"\nEZ_CONTROL_DIR="private control"\nEXTRA="keep me"\n')
    const purpose = path.join(root, 'purpose.md')
    await writeFile(purpose, 'Configured assistant\n')
    const token = '123456789:' + 'a'.repeat(30)
    const result = await configureInstallation(root, 'codex', token, purpose)
    assert.equal(result.tokenConfigured, true)
    assert.equal(JSON.stringify(result).includes(token), false)
    const env = parseEnv(await readFile(result.envFile, 'utf8'))
    assert.equal(env.EXTRA, 'keep me')
    assert.equal(env.TELEGRAM_BOT_TOKEN, token)
    assert.equal(env.EZ_AGENT_WORKSPACE, path.join(root, 'my mind'))
    assert.equal((await stat(result.envFile)).mode & 0o777, 0o600)
    assert.equal(await readActiveExecutor(result.envFile), 'codex')
    const agents = path.join(result.workspace, 'AGENTS.md')
    await writeFile(agents, 'Customized purpose')
    const repeated = await configureInstallation(root, 'codex')
    assert.deepEqual(repeated.created, [])
    assert.equal(repeated.tokenConfigured, true)
    assert.match(await readFile(agents, 'utf8'), /Customized purpose/)
    await assert.rejects(stat(result.controlDir), { code: 'ENOENT' }) // No control/owner mutation.
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('configure rejects secret/path hazards without replacing existing configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-configure-'))
  try {
    const env = path.join(root, '.env')
    const original = 'EZ_AGENT_WORKSPACE="."\n'
    await writeFile(env, original)
    await assert.rejects(configureInstallation(root, 'codex'), /separate/)
    await assert.rejects(configureInstallation(root, 'codex', 'do-not-print-me'), error => !String(error).includes('do-not-print-me'))
    assert.equal(await readFile(env, 'utf8'), original)
    await rm(env)
    const target = path.join(root, 'private-file')
    await writeFile(target, 'preserve')
    await symlink(target, env)
    await assert.rejects(configureInstallation(root, 'codex'), /regular file/)
    assert.equal(await readFile(target, 'utf8'), 'preserve')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('packaged configure accepts token through stdin without echo or extra initialization', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-configure-cli-'))
  try {
    const token = '123456789:' + 'b'.repeat(30)
    const purpose = path.join(root, 'purpose.md')
    await writeFile(purpose, 'Packaged assistant\n')
    const bin = fileURLToPath(new URL('../bin/ezenciel-agents-setup.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [bin, 'configure', 'codex', '--purpose-file', purpose, '--token-stdin'], { cwd: root, input: token, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal((result.stdout + result.stderr).includes(token), false)
    assert.deepEqual(JSON.parse(result.stdout).created, ['AGENTS.md'])
    assert.equal(parseEnv(await readFile(path.join(root, '.env'), 'utf8')).TELEGRAM_BOT_TOKEN, token)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fresh configure refuses to invent a generic purpose', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-configure-purpose-'))
  try {
    await assert.rejects(configureInstallation(root, 'codex'), /purpose file is required/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Docker startup uses explicit deployment binding and literal paths without secrets or host supervisors', () => {
  const definition = serviceDefinition('/tmp/my agent $literal')
  assert.equal(definition.command, 'docker')
  assert.ok(definition.args.includes('/tmp/my agent $literal/docker.env'))
  assert.deepEqual(definition.args.slice(-4), ['up', '-d', '--wait', 'relay'])
  assert.deepEqual(serviceDefinition('/tmp/isolated', true).args.slice(-5), ['up', '-d', '--wait', 'relay', 'plugin-broker'])
  assert.doesNotMatch(JSON.stringify(definition), /TELEGRAM_BOT_TOKEN|launchctl|systemctl/)
  assert.throws(() => serviceDefinition('/tmp/\nbad'), /single-line/)
})
