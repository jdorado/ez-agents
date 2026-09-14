import { readFile,realpath } from 'node:fs/promises'
import { loadControlConfig } from './config.js'
import { parseMessageArgs, sendRunDocument, sendRunText, sendRunVoice } from './message-send.js'
import { RunStore } from './runs.js'
import { parseArgs } from 'node:util'
import { deliveredMessages } from './message-history.js'
import {authorizeDeliveryContext,currentDeliveryOwner} from './delivery-context.mjs'
import {workspaceFile} from './files.js'
import path from 'node:path'

const rawArgs = process.argv.slice(2)
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(
    'Usage: ezenciel-agents-message [--text-file <path> | --text <text>] [--document <path>] [--voice <text>] [--reply-to <id>]',
  )
  console.log('History: ezenciel-agents-message history [--limit 1..50] [--message-id ID] (read-only, bound Telegram chat, across sessions)')
  console.log("Authenticated channel: sends go directly to the paired owner's Telegram chat. receipt OUTBOX_ID reads delivery status; sends return queued ID then Telegram delivery receipt or unknown outcome. Never resend an uncertain operation.")
  console.log('Text: --text decodes \\n as a newline and \\\\ as a literal backslash; --text-file preserves file content.')
  process.exit(0)
}

const runId = process.env.EZ_RUN_ID?.trim()
const deliveryContext = !runId && process.env.EZ_DELIVERY_CONTEXT ? authorizeDeliveryContext(JSON.parse(process.env.EZ_DELIVERY_CONTEXT),await currentDeliveryOwner(loadControlConfig().controlDir)) : undefined
if(rawArgs[0]==='receipt') {
  if(!deliveryContext||rawArgs.length!==2)throw new Error('Receipt requires an authenticated delivery context and outbox ID')
  console.log(JSON.stringify(await new RunStore(loadControlConfig().controlDir).ownerDeliveryReceipt(deliveryContext,rawArgs[1]!)))
  process.exit(0)
}
if (rawArgs[0] === 'history') {
  try {
    const { values } = parseArgs({ args: rawArgs.slice(1), options: {
      limit: { type: 'string' }, 'message-id': { type: 'string' },
    } })
    if (!runId) throw new Error('EZ_RUN_ID is required')
    const result = await deliveredMessages(loadControlConfig().controlDir, runId, {
      limit: values.limit === undefined ? undefined : Number(values.limit),
      messageId: values['message-id'] === undefined ? undefined : Number(values['message-id']),
    })
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(result) + '\n', error => error ? reject(error) : resolve()))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  process.exit(0)
}
const args = parseMessageArgs(rawArgs)
if (!runId && !deliveryContext) {
  console.error('EZ_RUN_ID is required')
  process.exit(1)
}

const store = new RunStore(loadControlConfig().controlDir)

let textContent = args.text?.trim()
if (args.textFile) {
  if(deliveryContext)throw new Error('Channel delivery requires inline text, not host file input')
  try {
    textContent = (await readFile(args.textFile, 'utf8')).trim()
  } catch (err: any) {
    console.error(`Failed to read text file ${args.textFile}: ${err.message}`)
    process.exit(1)
  }
}

let item
if(deliveryContext) {
  if(args.document) {
    if(!process.env.EZ_AGENT_WORKSPACE)throw new Error('Channel delivery requires owning workspace')
    const documentPath=await workspaceFile(process.env.EZ_AGENT_WORKSPACE,args.document)
    item=await store.enqueueOwnerDelivery(deliveryContext,{type:'document',documentPath:path.relative(await realpath(process.env.EZ_AGENT_WORKSPACE),documentPath),text:textContent,replyToMessageId:args.replyTo})
  } else if(args.voice) item=await store.enqueueOwnerDelivery(deliveryContext,{type:'voice',voiceText:args.voice,replyToMessageId:args.replyTo})
  else if(textContent) item=await store.enqueueOwnerDelivery(deliveryContext,{type:'message',text:textContent,replyToMessageId:args.replyTo})
  else throw new Error('Message content is required')
} else if (args.document) {
  item = await sendRunDocument(store, runId!, args.document, textContent, { replyTo: args.replyTo })
} else if (args.voice) {
  item = await sendRunVoice(store, runId!, args.voice, { replyTo: args.replyTo })
} else if (textContent) {
  item = await sendRunText(store, runId!, textContent, { replyTo: args.replyTo })
} else {
  console.error(
    'Usage: ezenciel-agents-message [--text-file <path> | --text <text>] [--document <path>] [--voice <text>] [--reply-to <id>]',
  )
  process.exit(1)
}

try {
  if(deliveryContext)console.log(JSON.stringify({ok:true,status:'queued',outbox_id:item.id}))
  const receipt = await store.waitForDelivery(item.id,deliveryContext?20000:undefined)
  console.log(
    JSON.stringify({
      ok: true,
      status: 'delivered',
      run: runId,
      ...(deliveryContext?{connection:deliveryContext.connectionId}:{}),
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
