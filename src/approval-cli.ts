import { loadControlConfig } from './config.js'
import { ApprovalStore } from './approval.js'
import { RunStore } from './runs.js'

const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: ezenciel-agents-approval --prompt "..." --action-id "..." [--reply-to <id>]')
  console.log('   or: ezenciel-agents-approval --check <action-id>')
  process.exit(0)
}

let prompt: string | undefined
let actionId: string | undefined
let checkId: string | undefined
let replyTo: number | undefined

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prompt' && args[i + 1]) {
    prompt = args[++i]
  } else if (args[i] === '--action-id' && args[i + 1]) {
    actionId = args[++i]
  } else if (args[i] === '--check' && args[i + 1]) {
    checkId = args[++i]
  } else if (args[i] === '--reply-to' && args[i + 1]) {
    replyTo = parseInt(args[++i], 10)
  }
}

const config = loadControlConfig()
const approvalStore = new ApprovalStore(config.controlDir)

if (checkId) {
  const record = await approvalStore.getDecision(checkId)
  console.log(JSON.stringify({
    ok: true,
    actionId: checkId,
    decision: record?.decision || 'pending',
    decidedAt: record?.decidedAt,
    decidedBy: record?.decidedBy,
  }))
  process.exit(0)
}

if (!prompt || !actionId) {
  console.error('Usage: ezenciel-agents-approval --prompt "..." --action-id "..." [--reply-to <id>]')
  console.error('   or: ezenciel-agents-approval --check <action-id>')
  process.exit(1)
}

const runId = process.env.EZ_RUN_ID?.trim()
if (!runId) {
  console.error('EZ_RUN_ID is required to request approval')
  process.exit(1)
}

const runStore = new RunStore(config.controlDir)
await approvalStore.requestApproval(actionId, prompt, runId)
const item = await runStore.enqueueApproval(runId, prompt, actionId, { replyToMessageId: replyTo })
console.log(JSON.stringify({ ok: true, run: runId, actionId, outbox_id: item.id, status: 'requested' }))
