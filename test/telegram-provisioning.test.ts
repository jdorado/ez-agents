import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  const deploymentEnvFile = path.join(root, 'docker.env')
  await writeFile(composeFile, 'services: {}\n')
  await writeFile(deploymentEnvFile, "EZ_RELAY_IMAGE='ezenciel-agents:0.1.0-beta.36.rc.4'\n", { mode: 0o600 })
  await writeFile(configFile, JSON.stringify({
    version: 1,
    composeFile,
    projectDirectory: root,
    projectName: 'tenant-aifit',
    service: 'relay',
    relayEnvFile,
    overrideFile,
  }), { mode: 0o600 })
  return { root, composeFile, configFile, relayEnvFile, overrideFile, deploymentEnvFile }
}

test('Telegram provisioning writes only a private relay secret and restarts the exact relay', async (t) => {
  const value = await fixture()
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(value.root, { recursive: true, force: true })) })
  const calls: string[][] = []
  await provisionTelegramBot(value.configFile, token, async (args) => { calls.push(args) })

  assert.equal(await readFile(value.relayEnvFile, 'utf8'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  assert.equal((await stat(value.relayEnvFile)).mode & 0o777, 0o600)
  const override = await readFile(value.overrideFile, 'utf8')
  // The installed deployment supplies the relay image; the override never sets one.
  assert.ok(!override.includes('image:'))
  assert.match(override, /relay_env/)
  assert.match(override, /EZ_TELEGRAM_ENABLED: "true"/)
  assert.ok(!override.includes(token))
  assert.equal((await stat(value.overrideFile)).mode & 0o777, 0o600)
  assert.deepEqual(calls, [[
    '--project-directory', value.root,
    '--project-name', 'tenant-aifit',
    '--env-file', value.deploymentEnvFile,
    '-f', value.composeFile,
    '-f', value.overrideFile,
    'up', '-d', '--wait', 'relay',
  ]])
})

test('provisioning rejects a self-set image and custom deployments without a Docker env file still start', async (t) => {
  const value = await fixture()
  t.after(async () => { await rm(value.root, { recursive: true, force: true }) })
  const configured = JSON.parse(await readFile(value.configFile, 'utf8'))
  await writeFile(value.configFile, JSON.stringify({ ...configured, image: 'eizenciel-agents:0.1.0-beta.36.rc.3' }))
  await assert.rejects(provisionTelegramBot(value.configFile, token, async () => {}), /Invalid Telegram provisioning configuration/)
  await writeFile(value.configFile, JSON.stringify(configured))
  await rm(value.deploymentEnvFile)
  const calls: string[][] = []
  await provisionTelegramBot(value.configFile, token, async (args) => { calls.push(args) })
  assert.ok(!calls[0].includes('--env-file'))
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

test('Telegram provisioning rejects invalid tokens and configs before touching the deployment', async (t) => {
  const value = await fixture()
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(value.root, { recursive: true, force: true })) })
  await assert.rejects(provisionTelegramBot(value.configFile, 'not-a-token', async () => {}), /Invalid Telegram bot token/)
  await assert.rejects(provisionTelegramBot(value.configFile, `${'1'.repeat(600)}:x`, async () => {}), /Invalid Telegram bot token/)
  await assert.rejects(readFile(value.relayEnvFile, 'utf8'), { code: 'ENOENT' })
  await writeFile(value.configFile, JSON.stringify({ version: 1 }))
  await assert.rejects(provisionTelegramBot(value.configFile, token, async () => {}), /Invalid Telegram provisioning configuration/)
})

test('Telegram rotation failure restores both files and restarts with the previous override', async (t) => {
  const value = await fixture()
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(value.root, { recursive: true, force: true })) })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path.dirname(value.relayEnvFile), { recursive: true })
  await writeFile(value.relayEnvFile, 'TELEGRAM_BOT_TOKEN=111111:old-old-old-old-old-old-old-old\n', { mode: 0o600 })
  await writeFile(value.overrideFile, 'previous-override\n')
  const calls: string[][] = []
  await assert.rejects(
    provisionTelegramBot(value.configFile, token, async (args) => {
      calls.push(args)
      if (calls.length === 1) throw new Error('Bot rejected rotation')
    }),
    /Bot rejected rotation/,
  )
  assert.equal(await readFile(value.relayEnvFile, 'utf8'), 'TELEGRAM_BOT_TOKEN=111111:old-old-old-old-old-old-old-old\n')
  assert.equal(await readFile(value.overrideFile, 'utf8'), 'previous-override\n')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes(value.overrideFile))
})

test('Telegram provisioning refuses a live lock but recovers a stale one', async (t) => {
  const value = await fixture()
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(value.root, { recursive: true, force: true })) })
  const calls: string[][] = []
  await writeFile(path.join(value.root, 'telegram-provisioning.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  await assert.rejects(provisionTelegramBot(value.configFile, token, async (args) => { calls.push(args) }), /already in progress/)
  assert.equal(calls.length, 0)
  await writeFile(path.join(value.root, 'telegram-provisioning.lock'), JSON.stringify({ pid: 2147483647, startedAt: '2020-01-01T00:00:00.000Z' }))
  await provisionTelegramBot(value.configFile, token, async (args) => { calls.push(args) })
  assert.equal(calls.length, 1)
})

test('Telegram provisioning CLI rejects TTY input and oversized stdin', async () => {
  const { runTelegramProvisioningCli } = await import('../src/telegram-provisioning-cli.js')
  await assert.rejects(runTelegramProvisioningCli(['--config', 'x'], { isTTY: true } as never), /stdin/)
  let destroyed = false
  const oversized = {
    isTTY: false,
    destroy() { destroyed = true },
    async *[Symbol.asyncIterator]() { yield 'x'.repeat(600) },
  }
  await assert.rejects(runTelegramProvisioningCli(['--config', 'x'], oversized as never), /too long/)
  assert.equal(destroyed, true)
})
