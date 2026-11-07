import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { taskArguments } from '../src/task-executor.js'
import { initializeWorkspace } from '../src/workspace.js'

test('workspace initialization preserves a customized AGENTS.md and does not inject a shared handbook', async () => {
  const root = path.join(tmpdir(), `ez-guidance-workspace-${randomUUID()}`)
  const workspace = path.join(root, 'agent')
  try {
    await mkdir(root, { recursive: true })
    const purpose = path.join(root, 'purpose.md')
    await writeFile(purpose, 'Fixture agent\n')
    await initializeWorkspace(workspace, purpose)
    const seeded = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8')
    assert.ok(!seeded.includes('ez shared guidance'))
    assert.ok(!/KISS|independent final-head review|ezenciel-agents-message|inbox\/|work\//i.test(seeded))
    assert.match(seeded, /## Purpose\n\nFixture agent/)
    const custom = '# Workspace-specific purpose\nKeep this local guidance unchanged.\n'
    await writeFile(path.join(workspace, 'AGENTS.md'), custom)
    await initializeWorkspace(workspace)
    assert.equal(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), custom)
    const installed = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8')
    await initializeWorkspace(workspace)
    assert.equal(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), installed)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restricted task arguments retain bounded permissions and do not receive owner guidance', () => {
  const directory = '/tmp/ez-restricted-task/workspace'
  const args = taskArguments(directory, ['node', 'broker'], 'approved task')
  assert.ok(args.includes('default_permissions="ez-task"'))
  assert.ok(args.includes(`permissions.ez-task.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(directory)}="write"}`))
  assert.ok(args.includes('permissions.ez-task.network.enabled=false'))
  assert.ok(args.includes('--disable') && args.includes('shell_tool'))
  assert.ok(!args.some((arg) => arg.includes('# Shared Ez guidance')))
})

test('workspace initialization never rewrites an existing AGENTS.md: old marked blocks, mode and inode stay', async t => {
  const root = path.join(tmpdir(), `ez-guidance-untouched-${randomUUID()}`)
  await mkdir(root); t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'AGENTS.md')
  const text = '# Identity\nPersonal.\n<!-- ez shared guidance: begin -->\nold block\n<!-- ez shared guidance: end -->\n<!-- ez tools: begin -->\nold footer\n<!-- ez tools: end -->\n'
  await writeFile(file, text)
  await chmod(file, 0o660)
  const before = await stat(file)
  await initializeWorkspace(root)
  const after = await stat(file)
  assert.equal(await readFile(file, 'utf8'), text)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mode & 0o777, 0o660)
})
