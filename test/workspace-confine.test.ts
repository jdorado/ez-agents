import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { macosWorkspaceProfile, workspaceSiblingDenies } from '../src/workspace-confine.js'

test('sibling confinement skips $HOME and filesystem root', () => {
  assert.deepEqual(workspaceSiblingDenies('/Users/ada/agent', '/Users/ada'), [])
  assert.deepEqual(workspaceSiblingDenies('/', '/Users/ada'), [])
})

test('sibling confinement denies the tenant farm, not the bound workspace', () => {
  assert.deepEqual(workspaceSiblingDenies('/data/tenants/juan', '/Users/ada'), [
    { deny: '/data/tenants', allow: '/data/tenants/juan' },
  ])
})

test('macos profile blocks sibling reads and writes', async (t) => {
  if (process.platform !== 'darwin') { t.skip(); return }
  const root = await mkdtemp(path.join(tmpdir(), 'ez-confine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mine = path.join(root, 'juan')
  const other = path.join(root, 'other')
  await mkdir(mine); await mkdir(other)
  await writeFile(path.join(mine, 'own.txt'), 'own')
  await writeFile(path.join(other, 'secret.txt'), 'secret')
  const profile = path.join(root, 'workspace.sb')
  await writeFile(profile, macosWorkspaceProfile(workspaceSiblingDenies(mine, '/Users/ada')))
  const run = (file: string) => new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn('sandbox-exec', ['-f', profile, '/bin/cat', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stderr }))
  })
  assert.equal((await run(path.join(mine, 'own.txt'))).code, 0)
  const blocked = await run(path.join(other, 'secret.txt'))
  assert.notEqual(blocked.code, 0)
  assert.match(blocked.stderr, /not permitted|Operation not permitted/i)
})
