import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { RunStore } from '../src/runs.js'

const exec = promisify(execFile)
const tsx = createRequire(import.meta.url).resolve('tsx')

test('a relay restart starts from an empty memory ledger and leaves no run files behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-container-recovery-'))
  try {
    // A previous relay process owned runs in its own memory. Nothing is written
    // to control/, so a fresh process cannot replay or resurrect them.
    const script = `
      import { RunStore } from ${JSON.stringify(new URL('../src/runs.ts', import.meta.url).href)};
      const store = new RunStore(process.argv[1]);
      const run = await store.create({ chatId: 1, telegramUserId: 1, texts: ['old'] });
      await store.patch(run.id, { status: 'running', pid: process.pid });
      const queued = await store.create({ chatId: 1, telegramUserId: 1, texts: ['queued'] });
      console.log(JSON.stringify({ count: (await store.list()).length }));
    `
    const { stdout } = await exec(process.execPath, ['--import', tsx, '--input-type=module', '-e', script, dir])
    assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)!).count, 2)

    const fresh = new RunStore(dir)
    assert.equal((await fresh.list()).length, 0, 'restart drops in-flight runs by design')
    await assert.rejects(stat(join(dir, 'runs')), { code: 'ENOENT' })
    await assert.rejects(stat(join(dir, 'outbox')), { code: 'ENOENT' })
    await assert.rejects(stat(join(dir, 'inbox.json')), { code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
