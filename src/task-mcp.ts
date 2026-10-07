import {randomBytes,createHash} from 'node:crypto'
import { createInterface } from 'node:readline'
import { taskCall } from './task-rpc.js'
import { runTaskCapability,launchTaskApplication } from './task-capability.js'
import type { TaskCapability } from './tasks.js'
const [controlDir, runId, toolsHome, capabilityJson='[]', applicationsJson='[]'] = process.argv.slice(2)
const capabilities = JSON.parse(capabilityJson) as TaskCapability[]
const applications=JSON.parse(applicationsJson) as string[]
const descriptions: Record<string, string> = {
  ...(applications.length ? {browser_link:`Create a short-lived single-use browser conversation link for this discussion. Applications: ${applications.join(", ")}. Return the exact link as text to this same discussion; the link is a private bearer credential.`} : {}),
  context: 'Read the owner-approved purpose and shareable context, task notes, receipts, and untrusted correspondence.',
  read_attachment: 'Read a JPEG/PNG/WebP image, an MP4 video as sampled frames (up to 120 seconds), or a TXT/Markdown/PDF document from an incomingId in this run context. Returns the image to native vision, or bounded extracted document text, with file provenance; no owner files are accessible.',
  send: 'Send text, or set voice=true for a spoken reply (at most 1000 characters). Optionally use an attachmentId returned by an approved file capability to this conversation. Reuse the same key for the same message. Uncertain means do not retry with a new key.',
  note: 'Save a task-scoped note. No owner files or memory are accessible.',
  report: 'Report task evidence or a blocker to the owner. This is a report, never an owner instruction.',
  complete: 'Report the result and close a finite task, stopping further messages and replies. Not available for incoming-only watches; save a note and end the run instead.',
  ...Object.fromEntries(capabilities.map(item => [`capability_${item.id}`,item.description])),
}
const tools = Object.entries(descriptions).map(([name, description]) => {
  const capability = name.startsWith('capability_')
  return { name, description, inputSchema: {
    type: 'object', properties: name==='browser_link' ? {application:{type:'string',enum:applications}} : name === 'context' ? {} : name === 'read_attachment' ? {incomingId:{type:'string',maxLength:100}} : capability ? {input:{type:'string',maxLength:1000}} : { text: { type: 'string', maxLength: 4096 }, ...(name === 'send' ? { voice: {type:'boolean'}, key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, attachmentId:{type:'string',pattern:'^[a-f0-9-]{36}$'} } : {}) },
    required: name==='browser_link' ? ['application'] : name === 'context' ? [] : name === 'read_attachment' ? ['incomingId'] : capability ? ['input'] : name === 'send' ? ['text', 'key'] : ['text'], additionalProperties: false,
  } }
})
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
      const capabilityId = typeof name === 'string' && name.startsWith('capability_') ? name.slice(11) : undefined
      if (Object.keys(args).some(key => name==='browser_link' ? key!=='application' : name === 'read_attachment' ? key !== 'incomingId' : capabilityId ? key !== 'input' : !['text', ...(name === 'send' ? ['key','attachmentId','voice'] : [])].includes(key))) throw new Error('Unexpected tool argument')
      try {
        let data: unknown
        if(name==='browser_link') {
          if(!applications.includes(args.application))throw Error('Application is not authorized')
          const token=randomBytes(32).toString('hex'),ticketHash=createHash('sha256').update(token).digest('hex')
          const grant=await taskCall(controlDir,runId,'worker','application_launch',{application:args.application,ticketHash}) as {launch:{command:string;args:string[]};taskId:string;expiresAt:number}
          data=await launchTaskApplication(toolsHome,grant.launch,{taskId:grant.taskId,taskToken:token,expiresAt:grant.expiresAt},runId)
        } else if (capabilityId) {
          const begun = await taskCall(controlDir,runId,'worker','capability_begin',{id:capabilityId,input:args.input}) as {capability:TaskCapability;lease:string}
          const result = await runTaskCapability(toolsHome || undefined,begun.capability,args.input,{controlDir,runId,lease:begun.lease})
          await taskCall(controlDir,runId,'worker','capability_result',{id:capabilityId,input:args.input,lease:begun.lease,...('attachment' in result?{attachment:result.attachment}:{})})
          data = result.attachment ? {attachmentId:result.attachment.id,filename:result.attachment.filename,bytes:result.attachment.bytes} : result
        } else data = await taskCall(controlDir, runId, 'worker', name, args)
        if (name === 'read_attachment' && data && typeof data === 'object' && ('image' in data || 'images' in data)) {
          const {image,images,...metadata} = data as {image?:{data:string;mimeType:string};images?:{data:string;mimeType:string}[];[key:string]:unknown}
          result = { content: [{type:'text',text:JSON.stringify(metadata)}, ...(images ?? [image!]).map(value=>({type:'image',...value}))] }
        } else result = { content: [{ type: 'text', text: JSON.stringify(data) }] }
      }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Task tool failed' }] } }
    } else throw new Error('Unsupported MCP method')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: error instanceof Error ? error.message : 'Invalid request' } }) + '\n')
  }
}
