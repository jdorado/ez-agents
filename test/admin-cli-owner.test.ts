import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { chown, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ControlStore } from '../src/control-state.js'

const exec = promisify(execFile), bin = (name: string) => fileURLToPath(new URL(`../bin/${name}.mjs`, import.meta.url))

test('root administrator commands write control state as the control directory owner', {skip: process.geteuid?.() !== 0}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-admin-root-')), secrets = await mkdtemp(join(tmpdir(), 'ez-admin-secret-')), runtime = 20000
  t.after(() => Promise.all([rm(dir, {recursive: true, force: true}), rm(secrets, {recursive: true, force: true})]))
  const control = new ControlStore(dir, 1000); await control.requestPairing(101, 101); await control.approveOwner(101)
  // The runtime user owns its control directory, as the container entrypoint provisions it.
  await chown(dir, runtime, runtime); for (const name of await readdir(dir)) await chown(join(dir, name), runtime, runtime)
  // The administrator's token file stays private to root.
  const token = join(secrets, 'token'); await writeFile(token, randomBytes(32).toString('base64url'), {mode: 0o600})
  const env = {...process.env, EZ_CONTROL_DIR: dir, EZ_RUN_ID: ''}
  const run = async (name: string, ...args: string[]) => JSON.parse((await exec(process.execPath, [bin(name), ...args], {env})).stdout)
  assert.equal((await run('ezenciel-agents-application', '--id', 'web', '--token-file', token)).ok, true)
  assert.equal((await run('ezenciel-agents-source', '--name', 'unused', '--remove')).ok, true)
  await exec(process.execPath, [bin('ezenciel-agents-owner'), 'status'], {env})
  for (const file of await readdir(dir)) assert.equal((await stat(join(dir, file))).uid, runtime, file)
  for (const file of ['application-bindings.json', 'event-sources.json', 'control-state.json']) assert.ok((await readdir(dir)).includes(file), file)
})
