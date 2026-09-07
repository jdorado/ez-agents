import { readFile } from 'node:fs/promises'
import { loadControlConfig } from './config.js'
import { parseMessageArgs, sendRunDocument, sendRunText, sendRunVoice } from './message-send.js'
import { RunStore } from './runs.js'

const rawArgs = process.argv.slice(2)
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(
    'Usage: ezenciel-agents-message [--text-file <path> | --text <text>] [--document <path>] [--voice <text>] [--reply-to <id>]',
  )
  process.exit(0)
}

const runId = process.env.EZ_RUN_ID?.trim()
const args = parseMessageArgs(rawArgs)
if (!runId) {
  console.error('EZ_RUN_ID is required')
  process.exit(1)
}

const store = new RunStore(loadControlConfig().controlDir)

let textContent = args.text?.trim()
if (args.textFile) {
  try {
    textContent = (await readFile(args.textFile, 'utf8')).trim()
  } catch (err: any) {
    console.error(`Failed to read text file ${args.textFile}: ${err.message}`)
    process.exit(1)
  }
}

let item
if (args.document) {
  item = await sendRunDocument(store, runId, args.document, textContent, { replyTo: args.replyTo })
} else if (args.voice) {
  item = await sendRunVoice(store, runId, args.voice, { replyTo: args.replyTo })
} else if (textContent) {
  item = await sendRunText(store, runId, textContent, { replyTo: args.replyTo })
} else {
  console.error(
    'Usage: ezenciel-agents-message [--text-file <path> | --text <text>] [--document <path>] [--voice <text>] [--reply-to <id>]',
  )
  process.exit(1)
}

try {
  const receipt = await store.waitForDelivery(item.id)
  console.log(
    JSON.stringify({
      ok: true,
      status: 'delivered',
      run: runId,
      outbox_id: item.id,
      type: item.type,
      receipt,
    }),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      outbox_id: item.id,
      error: error instanceof Error ? error.message : 'Delivery failed',
    }),
  )
  process.exitCode = 1
}
