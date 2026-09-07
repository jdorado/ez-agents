import { dirname, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { ControlStore } from '../src/control-state.js'
import { startExecutorJob, terminateJob } from '../src/executor.js'
import { RunStore } from '../src/runs.js'
import { createRelay } from '../src/index.js'

// Outbound integration test, not proof of Telegram intake or UI interactions.
// Run while the polling relay is stopped; the owner must already be paired.
async function main() {
  const config = loadConfig()
  let prompt = 'Smoke test: use the messaging tool to send exactly "Smoke test passed ✅".'
  let resume = false
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume') resume = true
    else if (args[i] === '--cli' && args[i + 1]) config.executorCli = args[++i]
    else if (args[i] === '--prompt' && args[i + 1]) prompt = args[++i]
    else throw new Error('Usage: pnpm smoke [--cli grok] [--resume] [--prompt "..."]')
  }
  const relay = createRelay(config)
  await relay.bot.api.getMe()
  const state = await new ControlStore(config.controlDir, config.pairingTtlMs).status()
  const owner = state.owner
  const choice = state.ai?.presets.find(p => p.id === state.ai!.selectedId && p.cli === config.executorCli)
  const session = resume ? state.activeSession : undefined
  if (resume && (!session?.hasStarted || session.cli !== config.executorCli))
    throw new Error('Resume smoke requires an existing started session for the selected CLI')
  if (!owner) throw new Error('Pair an owner before running smoke')
  const runs = new RunStore(config.controlDir)
  if ((await runs.running()) || (await runs.nextQueued()))
    throw new Error('Stop the relay and finish queued work before smoke')
  const run = await runs.create({
    chatId: owner.telegramChatId,
    telegramUserId: owner.telegramUserId,
    texts: [prompt],
  })
  await runs.patch(run.id, { status: 'running', startedAt: new Date().toISOString() })
  const job = await startExecutorJob(run.texts, {
    workspace: config.workspace,
    timeoutMs: config.executorTimeoutMs,
    runId: run.id,
    controlDir: config.controlDir,
    binDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'bin'),
    cli: config.executorCli,
    model: choice?.model,
    effort: choice?.effort,
    sessionId: session?.nativeSessionId ?? session?.sessionId ?? randomUUID(),
    isResume: resume,
  }).catch(async (error) => {
    await runs.patch(run.id, { status: 'failed', endedAt: new Date().toISOString() })
    throw error
  })
  const stop = () => terminateJob(job.child)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const finished = new Promise<number>((resolve) => job.child.once('close', (code) => resolve(code ?? 1)))
  let drain: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    drain = drain.then(() => relay.drainOutbox(run.id))
  }, 500)
  try {
    await runs.patch(run.id, { pid: job.child.pid })
    const code = await finished
    clearInterval(timer)
    await drain
    await relay.drainOutbox(run.id)
    await runs.patch(run.id, {
      status: code === 0 ? 'completed' : 'failed',
      endedAt: new Date().toISOString(),
    })
    const names = (await readdir(join(config.controlDir, 'outbox'))).filter((name) =>
      name.startsWith(run.id + '_'),
    )
    const receipts = []
    for (const name of names.filter((name) => name.endsWith('.sent.json'))) {
      const item = JSON.parse(await readFile(join(config.controlDir, 'outbox', name), 'utf8'))
      if (item.receipt) receipts.push(item.receipt)
    }
    console.log(
      JSON.stringify({ runId: run.id, executor: config.executorCli, model: choice?.model, effort: choice?.effort, exitCode: code, receipts }, null, 2),
    )
    if (code !== 0 || !receipts.length || names.some((name) => !name.endsWith('.sent.json'))) {
      throw new Error('Smoke failed: executor failure, missing receipt, or undelivered outbox item')
    }
    console.log('Outbound smoke passed. Telegram intake and button/media UI still require a live chat test.')
  } finally {
    clearInterval(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await job.cleanup()
    await relay.stop()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
