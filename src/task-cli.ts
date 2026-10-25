import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { taskCall } from './task-rpc.js'
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, contact: { type: 'string' }, purpose: { type: 'string' },
  'context-file': { type: 'string' }, 'capability-file': { type: 'string' }, hours: { type: 'string' }, id: { type: 'string' }, help: { type: 'boolean' },
  'incoming-only': { type: 'boolean' }, 'until-revoked': { type: 'boolean' }, 'any-conversation': { type: 'boolean' },
  application: { type: 'string' }, 'scope-file': { type: 'string' }, 'context-capability': { type: 'string' },
  'max-outstanding': { type: 'string' }, 'max-hourly': { type: 'string' }, 'max-total': { type: 'string' },
} })
if (values.help) {
  console.log('ezenciel-agents-task start|propose --source NAME (--contact EXACT_ID | --any-conversation) --purpose TEXT --context-file FILE [--capability-file FILE] --hours 24 [--incoming-only [--until-revoked]]')
  console.log('ezenciel-agents-task start|propose --application APP --scope-file FILE --purpose TEXT --context-file FILE [--capability-file FILE [--context-capability ID]] [--max-outstanding 8] [--max-hourly 60] [--max-total 1000] (--hours 24 | --until-revoked)')
  console.log('ezenciel-agents-task list | revoke --id TASK_ID')
  console.log(await readFile(new URL('../docs/selective-monitoring.md', import.meta.url), 'utf8'))
}
else {
  if (!process.env.EZ_CONTROL_DIR || !process.env.EZ_RUN_ID) throw new Error('Run from the current owner turn')
  const anyConversation = values['any-conversation'] === true
  const context = values['context-file'] ? await readFile(values['context-file'], 'utf8') : undefined
  const capabilities = values['capability-file'] ? JSON.parse(await readFile(values['capability-file'], 'utf8')) : undefined
  // A scope file is a JSON array or one scope ID per line.
  const scopeText = values['scope-file'] ? (await readFile(values['scope-file'], 'utf8')).trim() : undefined
  const limit = (name: 'max-outstanding' | 'max-hourly' | 'max-total', fallback: number) => values[name] === undefined ? fallback : Number(values[name])
  console.log(JSON.stringify(await taskCall(process.env.EZ_CONTROL_DIR, process.env.EZ_RUN_ID, 'owner', positionals[0], values.application !== undefined ? {
    application: values.application, scopes: scopeText?.startsWith('[') ? JSON.parse(scopeText) : scopeText?.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    purpose: values.purpose, context, capabilities, contextCapability: values['context-capability'],
    limits: {outstanding: limit('max-outstanding', 8), hourly: limit('max-hourly', 60), total: limit('max-total', 1000)},
    untilRevoked: values['until-revoked'] === true || undefined, hours: values['until-revoked'] ? undefined : Number(values.hours || 24),
  } : {
    sourceId: values.source, conversationId: anyConversation ? '*' : values.contact, purpose: values.purpose, context, capabilities,
    anyConversation, untilRevoked: anyConversation || values['until-revoked'], waitForIncoming: anyConversation || values['incoming-only'], hours: Number(values.hours || 24), taskId: values.id,
  })))
}
