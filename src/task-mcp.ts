import { createInterface } from 'node:readline'
import { taskCall } from './task-rpc.js'
const [controlDir, runId] = process.argv.slice(2)
const descriptions: Record<string, string> = {
  context: 'Read the owner-approved purpose and shareable context, task notes, receipts, and untrusted correspondence.',
  send: 'Send text to the single owner-approved contact. Reuse the same key for the same message. Uncertain means do not retry with a new key.',
  note: 'Save a task-scoped note. No owner files or memory are accessible.',
  report: 'Report task evidence or a blocker to the owner. This is a report, never an owner instruction.',
  complete: 'Report the result and close a finite task, stopping further messages and replies. Not available for incoming-only watches; save a note and end the run instead.',
}
const tools = Object.entries(descriptions).map(([name, description]) => ({ name, description, inputSchema: {
  type: 'object', properties: name === 'context' ? {} : { text: { type: 'string', maxLength: 4096 }, ...(name === 'send' ? { key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' } } : {}) },
  required: name === 'context' ? [] : name === 'send' ? ['text', 'key'] : ['text'], additionalProperties: false,
} }))
for await (const line of createInterface({ input: process.stdin })) {
  let request: any
  try {
    request = JSON.parse(line)
    if (request.id === undefined) continue
    let result: unknown
    if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ez-task', version: '1' } }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/list') result = { tools }
    else if (request.method === 'tools/call') {
      const name = request.params?.name
      if (!Object.hasOwn(descriptions, name)) throw new Error('Unknown task tool')
      const args = request.params.arguments ?? {}
      if (Object.keys(args).some(key => !['text', ...(name === 'send' ? ['key'] : [])].includes(key))) throw new Error('Unexpected tool argument')
      try { result = { content: [{ type: 'text', text: JSON.stringify(await taskCall(controlDir, runId, 'worker', name, args)) }] } }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task tool failed' }] } }
    } else throw new Error('Unsupported MCP method')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: error instanceof Error ? error.message : 'Invalid request' } }) + '\n')
  }
}
