import { createInterface } from 'node:readline'
import { replyCall } from './reply-context.js'
const [controlDir, runId, workspace] = process.argv.slice(2)
const tools = [
  { name: 'context', description: 'Read this owner request, recent conversation, active and historical runs, and task progress.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ...['send', 'defer'].map(name => ({ name, description: name === 'send' ? 'Send one answer to the paired owner. Repeated calls reuse the same receipt.' : 'Queue the current owner request for a writer session. Include needed context and acceptance checks in text. Optional model and effort select the worker independently; defaults are gpt-5.6-luna/max. Repeated calls return the same schedule.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 8000 }, ...(name === 'defer' ? { model: { type: 'string', maxLength: 160 }, effort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] } } : {}) }, required: ['text'], additionalProperties: false } })),
]
for await (const line of createInterface({ input: process.stdin })) {
  let request: any
  try {
    request = JSON.parse(line)
    if (request.id === undefined) continue
    let result: unknown
    if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ez-reply', version: '1' } }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/list') result = { tools }
    else if (request.method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: JSON.stringify(await replyCall(controlDir, runId, workspace, request.params?.name, request.params?.arguments ?? {})) }] } }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Reply tool failed' }] } }
    } else throw new Error('Unsupported MCP method')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch { if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'Invalid reply request' } }) + '\n') }
}
