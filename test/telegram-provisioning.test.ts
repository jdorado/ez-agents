import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { provisionTelegramBot } from '../src/telegram-provisioning.js'

const token = '123456:abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMN'

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-telegram-provisioning-'))
  const composeFile = path.join(root, 'compose.yml')
  const configFile = path.join(root, 'telegram-provisioning.json')
  const relayEnvFile = path.join(root, 'secrets', 'relay.env')
  const overrideFile = path.join(root, 'telegram.compose.yml')
  await writeFile(composeFile, 'services: {}\n')
  await writeFile(configFile, JSON.stringify({
    version: 1,
    composeFile,
    projectDirectory: root,
    projectName: 'tenant-aifit',
    service: 'relay',
    relayEnvFile,
    overrideFile,
    image: 'aifit-ez-purpose:telegram-pair',
  }), { mode: 0o600 })
  return { root, composeFile, configFile, relayEnvFile, overrideFile }
}

test('Telegram provisioning writes only a private relay secret and restarts the exact relay', async (t) => {
  const value = await fixture()
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(value.root, { recursive: true, force: true })) })
  const calls: string[][] = []
  await provisionTelegramBot(value.configFile, token, async (args) => { calls.push(args) })

  assert.equal(await readFile(value.relayEnvFile, 'utf8'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  assert.equal((await stat(value.relayEnvFile)).mode & 0o777, 0o600)
  const override = await readFile(value.overrideFile, 'utf8')
  assert.match(override, /image: "aifit-ez-purpose:telegram-pair"/)
  assert.match(override, /relay_env/)
  assert.ok(!override.includes(token))
  assert.deepEqual(calls, [[
    '--project-directory', value.root,
    '--project-name', 'tenant-aifit',
    '-f', value.composeFile,
    '-f', value.overrideFile,
    'up', '-d', '--wait', 'relay',
  ]])
})

test('Telegram provisioning restores the botless relay when startup fails', async (t) => {
  const value = await fixture()
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(value.root, { recursive: true, force: true })) })
  const calls: string[][] = []
  await assert.rejects(
    provisionTelegramBot(value.configFile, token, async (args) => {
      calls.push(args)
      if (calls.length === 1) throw new Error('Bot rejected')
    }),
    /Bot rejected/,
  )
  await assert.rejects(readFile(value.relayEnvFile, 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(value.overrideFile, 'utf8'), { code: 'ENOENT' })
  assert.equal(calls.length, 2)
  assert.ok(!calls[1].includes(value.overrideFile))
})
