import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { taskCall } from './task-rpc.js'
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, contact: { type: 'string' }, purpose: { type: 'string' },
  'context-file': { type: 'string' }, hours: { type: 'string' }, id: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) console.log('ezenciel-agents-task propose --source NAME --contact EXACT_ID --purpose TEXT --context-file FILE --hours 24 | list | revoke --id TASK_ID')
else {
  if (!process.env.EZ_CONTROL_DIR || !process.env.EZ_RUN_ID) throw new Error('Run from the current owner turn')
  console.log(JSON.stringify(await taskCall(process.env.EZ_CONTROL_DIR, process.env.EZ_RUN_ID, 'owner', positionals[0], {
    sourceId: values.source, conversationId: values.contact, purpose: values.purpose,
    context: values['context-file'] ? await readFile(values['context-file'], 'utf8') : undefined,
    hours: Number(values.hours || 24), taskId: values.id,
  })))
}
