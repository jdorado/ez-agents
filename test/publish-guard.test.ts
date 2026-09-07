import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/assert-local-registry.mjs')

const runGuard = (env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ...env } })

test('blocks a public npm registry', () => {
  const result = runGuard({ npm_config_registry: 'https://registry.npmjs.org/' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing to publish outside the local ez registry/)
})

test('allows the local verdaccio registry', () => {
  const result = runGuard({ npm_config_registry: 'http://127.0.0.1:4873/' })
  assert.equal(result.status, 0, result.stderr)
})
