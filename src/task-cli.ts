import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { taskCall } from './task-rpc.js'
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, contact: { type: 'string' }, purpose: { type: 'string' },
  'context-file': { type: 'string' }, 'capability-file': { type: 'string' }, hours: { type: 'string' }, id: { type: 'string' }, help: { type: 'boolean' },
  'incoming-only': { type: 'boolean' }, 'until-revoked': { type: 'boolean' }, 'any-conversation': { type: 'boolean' },
} })
if (values.help) { console.log('ezenciel-agents-task start|propose --source NAME (--contact EXACT_ID | --any-conversation) --purpose TEXT --context-file FILE [--capability-file FILE] --hours 24 [--incoming-only [--until-revoked]] | list | revoke --id TASK_ID'); console.log(await readFile(new URL('../docs/selective-monitoring.md', import.meta.url), 'utf8')) }
else {
  if (!process.env.EZ_CONTROL_DIR || !process.env.EZ_RUN_ID) throw new Error('Run from the current owner turn')
  const anyConversation = values['any-conversation'] === true
  console.log(JSON.stringify(await taskCall(process.env.EZ_CONTROL_DIR, process.env.EZ_RUN_ID, 'owner', positionals[0], {
    sourceId: values.source, conversationId: anyConversation ? '*' : values.contact, purpose: values.purpose,
    context: values['context-file'] ? await readFile(values['context-file'], 'utf8') : undefined,
    capabilities: values['capability-file'] ? JSON.parse(await readFile(values['capability-file'], 'utf8')) : undefined,
    anyConversation, untilRevoked: anyConversation || values['until-revoked'], waitForIncoming: anyConversation || values['incoming-only'], hours: Number(values.hours || 24), taskId: values.id,
  })))
}
