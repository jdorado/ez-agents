import { readFile,realpath } from 'node:fs/promises'
import { loadControlConfig } from './config.js'
import { parseMessageArgs } from './message-send.js'
import { parseArgs } from 'node:util'
import {authorizeDeliveryContext,currentDeliveryOwner} from './delivery-context.mjs'
import {workspaceFile} from './files.js'
import { callDeliverySocket, socketPathFor } from './delivery-socket.js'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

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

const controlDir = loadControlConfig().controlDir
const socketPath = socketPathFor(controlDir)
const runId = process.env.EZ_RUN_ID?.trim()
const deliveryContext = !runId && process.env.EZ_DELIVERY_CONTEXT ? authorizeDeliveryContext(JSON.parse(process.env.EZ_DELIVERY_CONTEXT),await currentDeliveryOwner(controlDir)) : undefined
if(rawArgs[0]==='receipt') {
  if(!deliveryContext||rawArgs.length!==2)throw new Error('Receipt requires an authenticated delivery context and outbox ID')
  console.log(JSON.stringify(await callDeliverySocket(socketPath, { op: 'receipt', payload: { context: deliveryContext, id: rawArgs[1]! } })))
  process.exit(0)
}
if (rawArgs[0] === 'history') {
  try {
    const { values } = parseArgs({ args: rawArgs.slice(1), options: {
      limit: { type: 'string' }, 'message-id': { type: 'string' },
    } })
    if (!runId) throw new Error('EZ_RUN_ID is required')
    const result = await callDeliverySocket(socketPath, { op: 'history', payload: {
      runId,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      messageId: values['message-id'] === undefined ? undefined : Number(values['message-id']),
    } })
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

// Delivery rides the relay socket (same envelope the relay pump delivers);
// the relay re-verifies ownership before sending. Client-generated IDs keep
// retried sends idempotent without a second delivery.
const envelope: Record<string, unknown> = {
  ...(runId ? { runId } : {}),
  ...(deliveryContext ? { kind: 'owner', deliveryContext } : {}),
  ...(args.replyTo !== undefined ? { replyToMessageId: args.replyTo } : {}),
}
if(deliveryContext) {
  if(args.document) {
    if(!process.env.EZ_AGENT_WORKSPACE)throw new Error('Channel delivery requires owning workspace')
    const documentPath=await workspaceFile(process.env.EZ_AGENT_WORKSPACE,args.document)
    Object.assign(envelope,{type:'document',documentPath:path.relative(await realpath(process.env.EZ_AGENT_WORKSPACE),documentPath),text:textContent})
  } else if(args.voice) Object.assign(envelope,{type:'voice',voiceText:args.voice})
  else if(textContent) Object.assign(envelope,{type:'message',text:textContent})
  else throw new Error('Message content is required')
} else if (args.document) {
  Object.assign(envelope,{kind:'document',documentPath:args.document,text:textContent})
} else if (args.voice) {
  Object.assign(envelope,{kind:'voice',voiceText:args.voice})
} else if (textContent) {
  Object.assign(envelope,{kind:'message',text:textContent,id:`${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`})
} else {
  console.error(
    'Usage: ezenciel-agents-message [--text-file <path> | --text <text>] [--document <path>] [--voice <text>] [--reply-to <id>]',
  )
  process.exit(1)
}

let item: { outbox_id: string; id: string; type?: string }
try {
  item = await callDeliverySocket(socketPath, { op: 'enqueue', payload: envelope }) as typeof item
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

try {
  if(deliveryContext)console.log(JSON.stringify({ok:true,status:'queued',outbox_id:item.id}))
  const receipt = await callDeliverySocket(socketPath,
    { op: 'wait', payload: { id: item.id } }, deliveryContext?30000:130000)
  console.log(
    JSON.stringify({
      ok: true,
      status: 'delivered',
      run: runId,
      ...(deliveryContext?{connection:deliveryContext.connectionId}:{}),
      outbox_id: item.id,
      type: item.type,
      receipt: (receipt as { receipt?: unknown }).receipt ?? receipt,
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
