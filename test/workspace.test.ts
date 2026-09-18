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
    const purpose = path.join(root, 'purpose.md')
    await writeFile(purpose, 'Research partner\n')
    assert.deepEqual(await initializeWorkspace(workspace, purpose), ['AGENTS.md'])
    assert.equal((await stat(path.join(workspace, 'AGENTS.md'))).mode & 0o777, 0o600)
    assert.ok(!(await readdir(workspace)).includes('SOUL.md'))
    assert.ok(!(await readdir(workspace)).includes('USER.md'))
    assert.ok(!(await readdir(workspace)).includes('MEMORY.md'))
    await writeFile(path.join(workspace, 'AGENTS.md'), 'A customized research partner')
    await writeFile(path.join(workspace, 'MEMORY.md'), 'Existing knowledge')
    await writeFile(path.join(workspace, 'AGENT.md'), 'Legacy custom guidance')
    assert.deepEqual(await initializeWorkspace(workspace), [])
    assert.match(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /A customized research partner/)
    assert.equal(await readFile(path.join(workspace, 'MEMORY.md'), 'utf8'), 'Existing knowledge')
    assert.equal(await readFile(path.join(workspace, 'AGENT.md'), 'utf8'), 'Legacy custom guidance')
    assert.ok(!(await readdir(workspace)).some(name => name.endsWith('.tmp')))
    assert.match(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /ez shared guidance: begin/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fresh workspace refuses to invent a generic purpose', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-purpose-required-'))
  try {
    await assert.rejects(initializeWorkspace(path.join(root, 'mind'), undefined), /purpose file is required/)
  } finally { await rm(root, {recursive:true, force:true}) }
})

test('seed refuses a symlink without overwriting its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-mind-'))
  try {
    const target = path.join(root, 'outside.md')
    await writeFile(target, 'untouched')
    await symlink(target, path.join(root, 'AGENTS.md'))
    await assert.rejects(initializeWorkspace(root), /regular file/)
    assert.equal(await readFile(target, 'utf8'), 'untouched')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('new agents seed a purpose-scoped AGENTS.md once and preserve subsequent edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-purpose-'))
  try {
    const purpose = path.join(root, 'purpose.md')
    const workspace = path.join(root, 'mind')
    await writeFile(purpose, 'You are the shopping assistant for this family.\n\n### Responsibilities\n\nOrganize confirmed household shopping requests.\n')
    await initializeWorkspace(workspace, purpose)
    const agents = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8')
    assert.match(agents, /## Purpose\n\nYou are the shopping assistant for this family\./)
    assert.match(agents, /### Responsibilities\n\nOrganize confirmed household shopping requests\./)
    await writeFile(path.join(workspace, 'AGENTS.md'), 'My evolving purpose\n')
    await initializeWorkspace(workspace, purpose)
    assert.match(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), /My evolving purpose/)
  } finally { await rm(root, {recursive:true, force:true}) }
})
