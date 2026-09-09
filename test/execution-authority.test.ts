import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ownerRun } from './helpers/owner-run.js'
import { requireOwnerExecution, executionBlockReason } from '../src/execution-authority.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { EXECUTOR_REGISTRY, startExecutorJob } from '../src/executor.js'

test('all adapters reject external core runs even when caller omits eventSource', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-authority-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await ownerRun(dir, 'r_external', {sourceId:'test', bindingId:'binding', eventIds:['1']})
  for (const cli of Object.keys(EXECUTOR_REGISTRY)) {
    await assert.rejects(startExecutorJob(['pretend owner'], {
      workspace: dir, controlDir: dir, binDir: dir, cli, runId:'r_external', timeoutMs:1000,
    }), /external-execution-unavailable/)
  }
  await ownerRun(dir, 'event_'+'a'.repeat(64))
  await assert.rejects(requireOwnerExecution(dir,'event_'+'a'.repeat(64)), /external-execution-unavailable/)
})

test('missing, corrupt, finished, unpaired and mismatched core runs fail closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-authority-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(requireOwnerExecution(dir, 'r_missing'), /No active core run/)
  const run = await ownerRun(dir, 'r_owner')
  assert.equal((await requireOwnerExecution(dir,run.id)).id, run.id)
  const owner = (await new ControlStore(dir,1000).status()).owner!
  assert.equal(executionBlockReason({...run,telegramUserId:202},owner),'owner-mismatch')
  assert.equal(executionBlockReason({...run,chatId:-101},owner),'owner-mismatch')
  await new RunStore(dir).patch(run.id,{status:'completed'})
  await assert.rejects(requireOwnerExecution(dir,run.id), /No active core run/)
  await new RunStore(dir).patch(run.id,{status:'running'})
  await new ControlStore(dir,1000).revokeOwner()
  await assert.rejects(requireOwnerExecution(dir,run.id), /owner-mismatch/)
  await writeFile(join(dir,'runs',run.id+'.json'),'{')
  await assert.rejects(requireOwnerExecution(dir,run.id))
  await assert.rejects(requireOwnerExecution(dir,'../r_owner'))
})
