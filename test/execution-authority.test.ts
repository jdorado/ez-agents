import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ownerRun } from './helpers/owner-run.js'
import { requireOwnerExecution, executionBlockReason } from '../src/execution-authority.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'

test('external core runs are rejected at admission, before the spawn core', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-authority-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await ownerRun(dir, 'r_external', {sourceId:'test', bindingId:'binding', eventIds:['1']})
  await assert.rejects(requireOwnerExecution(dir,'r_external'), /external-execution-unavailable/)
  await ownerRun(dir, 'event_'+'a'.repeat(64))
  await assert.rejects(requireOwnerExecution(dir,'event_'+'a'.repeat(64)), /external-execution-unavailable/)
})

test('missing, corrupt, finished and mismatched core runs fail closed without control writes', async t => {
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
  // Fail-closed authority is preserved with a read-only owner read: zero
  // control/ writes, rejects on revoked owner. Intake authorizes before spawn;
  // the slim core no longer reads or re-verifies the ledger.
  await new ControlStore(dir,1000).revokeOwner()
  await assert.rejects(requireOwnerExecution(dir,run.id), /owner-mismatch/)
  // Ledger lives in relay memory; corrupt authority state still fails closed
  // at the read-only owner check, and traversal fails at validation.
  await writeFile(join(dir,'control-state.json'),'{broken')
  await assert.rejects(requireOwnerExecution(dir,run.id))
  await assert.rejects(requireOwnerExecution(dir,'../r_owner'))
})
