import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installAgentGuidance } from '../src/agent-guidance.js'
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

test('upgrade strips the obsolete shared handbook and preserves personal instructions', async t => {
  const root = path.join(tmpdir(), `ez-guidance-upgrade-${randomUUID()}`)
  await mkdir(root); t.after(() => rm(root, { recursive: true, force: true }))
  const personal = '# Identity\r\nPersonal instructions and trailing spaces.  \r\n'
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    await writeFile(path.join(root, name), personal + '<!-- ez shared guidance: begin -->\nold installed defaults\nKISS coding and PR loops\n<!-- ez shared guidance: end -->\nTail stays.')
  }
  await installAgentGuidance(root)
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const result = await readFile(path.join(root, name), 'utf8')
    assert.ok(result.startsWith(personal)); assert.ok(result.endsWith('\nTail stays.'))
    assert.ok(!result.includes('ez shared guidance'))
    assert.ok(!result.includes('old installed defaults'))
    assert.ok(!result.includes('KISS coding'))
  }
  await installAgentGuidance(root)
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), personal + '\nTail stays.')
  const broken = '<!-- ez shared guidance: begin -->\nMy unfinished edit'
  await writeFile(path.join(root, 'AGENTS.md'), broken)
  await assert.rejects(installAgentGuidance(root), /Malformed/)
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), broken)
})
