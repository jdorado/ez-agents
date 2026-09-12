import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { initializeWorkspace } from '../src/workspace.js'

test('packaged launcher help and invalid arguments never start the relay', () => {
  const bin = fileURLToPath(new URL('../bin/ezenciel-agents.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', cwd: tmpdir(), timeout: 5000 })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /setup init/)
  const invalid = spawnSync(process.execPath, [bin, 'unknown'], { encoding: 'utf8', cwd: tmpdir(), timeout: 5000 })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Usage:/)
})

test('agent-facing binaries run when socket listeners are forbidden', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-no-listen-'))
  try {
    const preload = path.join(root, 'no-listen.cjs')
    await writeFile(preload, "require('node:net').Server.prototype.listen = function () { throw new Error('listen forbidden') }\n")
    for (const name of ['message', 'react', 'approval']) {
      const bin = fileURLToPath(new URL(`../bin/ezenciel-agents-${name}.mjs`, import.meta.url))
      const result = spawnSync(process.execPath, [bin, '--help'], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Usage:/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fresh mind is private; repeat initialization preserves customization and optional memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-mind-'))
  const workspace = path.join(root, 'agent')
  try {
    assert.equal((await initializeWorkspace(workspace)).length, 3)
    assert.equal((await stat(path.join(workspace, 'SOUL.md'))).mode & 0o777, 0o600)
    assert.ok(!(await readdir(workspace)).includes('MEMORY.md'))
    await writeFile(path.join(workspace, 'SOUL.md'), 'A customized research partner')
    await writeFile(path.join(workspace, 'MEMORY.md'), 'Existing knowledge')
    await writeFile(path.join(workspace, 'AGENT.md'), 'Legacy custom guidance')
    assert.deepEqual(await initializeWorkspace(workspace), [])
    assert.equal(await readFile(path.join(workspace, 'SOUL.md'), 'utf8'), 'A customized research partner')
    assert.equal(await readFile(path.join(workspace, 'MEMORY.md'), 'utf8'), 'Existing knowledge')
    assert.equal(await readFile(path.join(workspace, 'AGENT.md'), 'utf8'), 'Legacy custom guidance')
    assert.ok(!(await readdir(workspace)).some(name => name.endsWith('.tmp')))
    assert.match(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /ez shared guidance: begin/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('seed refuses a symlink without overwriting its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-mind-'))
  try {
    const target = path.join(root, 'outside.md')
    await writeFile(target, 'untouched')
    await symlink(target, path.join(root, 'SOUL.md'))
    await assert.rejects(initializeWorkspace(root), /regular file/)
    assert.equal(await readFile(target, 'utf8'), 'untouched')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('new agents seed their own purpose once and preserve subsequent mind edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-purpose-'))
  try {
    const purpose = path.join(root, 'purpose.md')
    const workspace = path.join(root, 'mind')
    await writeFile(purpose, 'Family shopping assistant\n')
    await initializeWorkspace(workspace, purpose)
    assert.equal(await readFile(path.join(workspace, 'SOUL.md'), 'utf8'), 'Family shopping assistant\n')
    await writeFile(path.join(workspace, 'SOUL.md'), 'My evolving purpose\n')
    await initializeWorkspace(workspace, purpose)
    assert.equal(await readFile(path.join(workspace, 'SOUL.md'), 'utf8'), 'My evolving purpose\n')
  } finally { await rm(root, {recursive:true, force:true}) }
})
