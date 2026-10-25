import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationChannel } from '../src/application-channel.js'
import { ApprovalStore } from '../src/approval.js'
import { initialPreset } from '../src/ai.js'
import { RunStore } from '../src/runs.js'
import { Tasks, type TaskCapability } from '../src/tasks.js'
import { runTaskCapability } from '../src/task-capability.js'
import { taskCommandAllowed } from '../src/plugins/exposure.mjs'
import { ownerRun } from './helpers/owner-run.js'

const read: TaskCapability = {id: 'lead', description: 'Read the lead record', command: 'crm-scope', args: ['lead', '--id', '{scope}'], access: 'read'}
const write: TaskCapability = {id: 'record', description: 'Record an outcome', command: 'crm-scope-write', args: ['note', '--id', '{scope}', '--', '{input}'], access: 'write'}

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ez-scoped-task-'))
  await ownerRun(dir, 'owner')
  const runs = new RunStore(dir), tasks = new Tasks(dir)
  let wakes = 0
  const channel = new ApplicationChannel({controlDir: dir, initial: initialPreset('codex'), wake: () => { wakes++ }, cancel: async id => { await runs.patch(id, {status: 'cancelled'}) }})
  const token = randomBytes(32).toString('base64url'), otherToken = randomBytes(32).toString('base64url')
  const owner = (await new (await import('../src/control-state.js')).ControlStore(dir, 900000).status()).owner!
  const binding = (await channel.bindings.register('crm', token, owner))!
  const other = (await channel.bindings.register('other', otherToken, owner))!
  const address = await channel.listen(0) as {port: number}
  t.after(async () => { await channel.stop(); await rm(dir, {recursive: true, force: true}) })
  const request = async (path: string, body: unknown, bearer = token) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {method: 'POST', headers: {Authorization: `Bearer ${bearer}`}, body: JSON.stringify(body)})
    return {status: response.status, body: await response.json() as any}
  }
  const grant = (extra: Record<string, unknown> = {}) => tasks.ownerCall('owner', 'start', {application: 'crm', scopes: ['lead-1', 'lead-2'], purpose: 'Ask owners whether they would sell',
    context: 'We buy multifamily buildings in Brooklyn.', capabilities: [read, write], contextCapability: 'lead', untilRevoked: true, ...extra}) as Promise<{id: string; state: string}>
  return {dir, runs, tasks, channel, binding, other, request, grant, otherToken, wakes: () => wakes}
}

test('owner grants one batch of application scopes within core ceilings; malformed scope grants fail closed', async t => {
  const f = await fixture(t)
  for (const [extra, error] of [
    [{limits: {outstanding: 9, hourly: 60, total: 1000}}, /limits within/],
    [{scopes: ['lead-1', 'lead-1']}, /unique scope IDs/],
    [{capabilities: [{...read, args: ['lead', '--id', 'fixed']}]}, /valid scoped capabilities/],
    [{capabilities: [{...write, access: 'admin'}]}, /valid scoped capabilities/],
    [{contextCapability: 'record'}, /read capability that takes no input/],
    [{application: 'missing'}, /Unknown application channel/],
    [{untilRevoked: undefined, hours: 100}, /maximum 72 hours/],
    [{sourceId: 'generic'}, /take an application/],
  ] as const) await assert.rejects(f.grant(extra), error)
  const created = await f.grant()
  assert.equal(created.state, 'active')
  const task = (await f.tasks.get(created.id))!
  assert.equal(task.version, 5)
  assert.deepEqual(task.limits, {outstanding: 8, hourly: 60, total: 1000})
  await assert.rejects(f.grant({scopes: ['lead-2', 'lead-3']}), /already has an application task/)

  const proposal = await f.tasks.ownerCall('owner', 'propose', {application: 'crm', scopes: ['lead-9'], purpose: 'Follow up', context: 'Shared facts.', hours: 24, limits: {outstanding: 2, hourly: 5, total: 20}}) as {id: string}
  const approval = (await new ApprovalStore(f.dir).getDecision(proposal.id))!
  assert.match(approval.prompt, /Scopes: 1 \(lead-9;/)
  assert.match(approval.prompt, /Limits: 2 outstanding; 5 runs and 5 replies per hour; 20 total/)
  await new ApprovalStore(f.dir).recordDecision(proposal.id, 'approved', 101)
  assert.equal(await f.tasks.decide(proposal.id), true)
  assert.equal((await f.tasks.get(proposal.id))!.state, 'active')
})

test('one application event starts exactly one scoped run; duplicates, other scopes and other channels do nothing', async t => {
  const f = await fixture(t)
  await f.grant()
  const first = await f.request('/v1/task-events', {eventId: 'sms-1', scope: 'lead-1'})
  assert.equal(first.status, 202)
  assert.equal(first.body.scope, 'lead-1')
  assert.equal(first.body.duplicate, false)
  assert.equal(f.wakes(), 1)
  const again = await f.request('/v1/task-events', {eventId: 'sms-1', scope: 'lead-1'})
  assert.deepEqual([again.status, again.body.id, again.body.duplicate], [200, first.body.id, true])
  assert.equal((await f.request('/v1/task-events', {eventId: 'sms-1', scope: 'lead-2'})).status, 409)
  const run = (await f.runs.get(first.body.id))!
  assert.deepEqual(run.application, {bindingId: f.binding.bindingId, scope: 'lead-1', requestId: 'sms-1', taskScope: true})
  await f.runs.patch(run.id, {status: 'completed'})
  // A pruned or restarted run store still cannot replay an admitted event.
  assert.deepEqual(await f.tasks.applicationEvent(f.binding.bindingId, {eventId: 'sms-1', scope: 'lead-1'}), {runId: run.id, duplicate: true})

  for (const [body, bearer] of [[{eventId: 'sms-2', scope: 'lead-3'}, undefined], [{eventId: 'sms-3', scope: 'lead-1'}, f.otherToken]] as const) {
    const refused = await f.request('/v1/task-events', body, bearer)
    assert.equal(refused.status, 404)
  }
  const refusals = JSON.parse(await readFile(join(f.dir, 'task-event-refusals.json'), 'utf8'))
  assert.deepEqual(refusals.map((item: any) => [item.eventId, item.scope]), [['sms-2', 'lead-3'], ['sms-3', 'lead-1']])
  assert.equal((await f.runs.list()).filter(item => item.taskId).length, 1)
  assert.equal((await f.request('/v1/task-events', {eventId: 'sms-4', scope: 'lead-2', text: 'no bodies'})).status, 400)
})

test('batch caps are shared across scopes; the lifetime cap revokes the grant for every scope', async t => {
  const f = await fixture(t)
  const {id} = await f.grant({limits: {outstanding: 1, hourly: 2, total: 3}})
  assert.equal((await f.request('/v1/task-events', {eventId: 'a', scope: 'lead-1'})).status, 202)
  assert.equal((await f.request('/v1/task-events', {eventId: 'b', scope: 'lead-2'})).status, 429)
  for (const run of await f.runs.list()) if (run.taskId) await f.runs.patch(run.id, {status: 'completed'})
  assert.equal((await f.request('/v1/task-events', {eventId: 'b', scope: 'lead-2'})).status, 202)
  for (const run of await f.runs.list()) if (run.taskId) await f.runs.patch(run.id, {status: 'completed'})
  assert.equal((await f.request('/v1/task-events', {eventId: 'c', scope: 'lead-1'})).status, 429)
  const task = (await f.tasks.get(id))!
  task.publicBudget!.windowStartedAt = 0
  await writeFile(join(f.dir, 'tasks', `${id}.json`), JSON.stringify(task))
  assert.equal((await f.request('/v1/task-events', {eventId: 'c', scope: 'lead-1'})).status, 202)
  for (const run of await f.runs.list()) if (run.taskId) await f.runs.patch(run.id, {status: 'completed'})
  assert.equal((await f.request('/v1/task-events', {eventId: 'd', scope: 'lead-2'})).status, 404)
  assert.equal((await f.tasks.get(id))!.state, 'revoked')
})

test('a scoped run replies only to its application inbox and its plugin token verifies only while authorized', async t => {
  const f = await fixture(t)
  const {id} = await f.grant()
  const admitted = await f.request('/v1/task-events', {eventId: 'sms-1', scope: 'lead-2'})
  const runId = admitted.body.id
  await f.runs.patch(runId, {status: 'running'})

  const context = await f.tasks.workerCall(runId, 'context', {}) as any
  assert.deepEqual([context.scope, context.capabilities.map((item: any) => item.access)], ['lead-2', ['read', 'write']])
  await assert.rejects(f.tasks.workerCall(runId, 'note', {text: 'cross-scope memory'}), /reply and use their capabilities only/)
  await assert.rejects(f.tasks.workerCall(runId, 'send', {text: 'Hi', key: 'k', voice: true}), /text only/)
  const sent = await f.tasks.workerCall(runId, 'send', {text: 'Hello, would you consider an offer?', key: 'opener'}) as any
  assert.equal(sent.state, 'accepted')
  assert.deepEqual(await f.tasks.workerCall(runId, 'send', {text: 'Hello, would you consider an offer?', key: 'opener'}), sent)
  const snapshot = await f.channel.snapshot(f.binding.bindingId, runId)
  assert.deepEqual(snapshot.messages.map((item: any) => item.text), ['Hello, would you consider an offer?'])

  await assert.rejects(f.tasks.workerCall(runId, 'capability_begin', {id: 'lead', input: 'other-lead'}), /invalid input/)
  const begun = await f.tasks.workerCall(runId, 'capability_begin', {id: 'record', input: 'Owner may sell in 2027'}) as any
  assert.deepEqual(begun.capability.args, ['note', '--id', 'lead-2', '--', '{input}'])
  assert.deepEqual(begun.pluginContext.task, {taskId: id, scope: 'lead-2', capability: 'record', access: 'write', token: begun.token, expiresAt: begun.pluginContext.task.expiresAt})
  const verify = (token: unknown, bearer?: string) => f.request('/v1/task-scope', {token}, bearer)
  const verified = await verify(begun.token)
  assert.deepEqual([verified.status, verified.body.scope, verified.body.access], [200, 'lead-2', 'write'])
  assert.equal((await verify(begun.token, f.otherToken)).status, 403)
  assert.equal((await verify('0'.repeat(64))).status, 403)

  const grant = await f.tasks.capabilityGrant(runId, {lease: begun.lease, input: 'Owner may sell in 2027', token: begun.token})
  assert.deepEqual(grant.args, ['note', '--id', 'lead-2', '--', 'Owner may sell in 2027'])
  await assert.rejects(f.tasks.capabilityGrant(runId, {lease: begun.lease, input: 'Owner may sell in 2027', token: '1'.repeat(64)}), /token is invalid/)
  await assert.rejects(f.tasks.capabilityGrant(runId, {lease: begun.lease, input: 'changed', token: begun.token}), /lease is invalid/)

  await f.tasks.workerCall(runId, 'capability_result', {id: 'record', input: 'Owner may sell in 2027', lease: begun.lease})
  assert.equal((await verify(begun.token)).status, 403)

  const fetched = await f.tasks.workerCall(runId, 'capability_begin', {id: 'lead'}) as any
  await f.tasks.workerCall(runId, 'capability_result', {id: 'lead', lease: fetched.lease, outputSha256: 'a'.repeat(64), bytes: 120})
  assert.deepEqual((await f.tasks.get(id))!.contextReceipts!.map(item => [item.runId, item.bytes]), [[runId, 120]])

  const later = await f.tasks.workerCall(runId, 'capability_begin', {id: 'lead'}) as any
  await f.tasks.ownerCall('owner', 'revoke', {taskId: id})
  assert.equal((await verify(later.token)).status, 403)
  await assert.rejects(f.tasks.workerCall(runId, 'send', {text: 'After revocation', key: 'late'}), /inactive or expired/)
  assert.equal((await f.request('/v1/task-events', {eventId: 'sms-2', scope: 'lead-2'})).status, 404)
})

test('scoped plugin commands must declare their access; the scope context reaches only that call', async t => {
  const exposure = (changesRecords: boolean) => ({receivesExternalContent: true, sendsExternally: false, changesRecords, requiresReview: false})
  assert.equal(taskCommandAllowed({taskScope: 'read', exposure: exposure(false)}, read), true)
  assert.equal(taskCommandAllowed({taskScope: 'read', exposure: exposure(false)}, write), false)
  assert.equal(taskCommandAllowed({taskScope: 'write', exposure: exposure(true)}, write), true)
  assert.equal(taskCommandAllowed({taskScope: 'write', exposure: {...exposure(true), sendsExternally: true}}, write), false)
  assert.equal(taskCommandAllowed({channelQuery: true, exposure: exposure(false)}, read), false)
  assert.equal(taskCommandAllowed({taskScope: 'read', exposure: exposure(false)}, {}), false)

  const root = await mkdtemp(join(tmpdir(), 'ez-scoped-capability-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'registry.json'), JSON.stringify({commands: {'crm-scope-write': 'crm'}, plugins: {crm: {manifest: {commands: {'crm-scope-write': {taskScope: 'write', exposure: exposure(true)}}}}}}))
  await writeFile(join(root, 'bin', 'ez'), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),context:process.env.EZ_TASK_PLUGIN_CONTEXT}))\n`, {mode: 0o700})
  const resolved = {...write, args: ['note', '--id', 'lead-2', '--', '{input}']}
  const pluginContext = {task: {scope: 'lead-2', token: 'f'.repeat(64)}}
  const result = await runTaskCapability(root, resolved, 'Sell in 2027', {controlDir: root, runId: 'r', lease: 'l', pluginContext})
  assert.deepEqual(JSON.parse(result.output!), {args: ['crm-scope-write', 'note', '--id', 'lead-2', '--', 'Sell in 2027'], context: JSON.stringify(pluginContext)})
  await writeFile(join(root, 'registry.json'), JSON.stringify({commands: {'crm-scope-write': 'crm'}, plugins: {crm: {manifest: {commands: {'crm-scope-write': {taskScope: 'read', exposure: exposure(false)}}}}}}))
  await assert.rejects(runTaskCapability(root, resolved, 'x', {controlDir: root, runId: 'r', lease: 'l'}), /not an installed scoped write command/)
})
