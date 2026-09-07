// File transport across the Docker/host boundary. The host chooses the CLI,
// workspace and environment; a request cannot choose a command or credentials.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { isHostRunId } from './host-executor-protocol.js'
const [control, id] = process.argv.slice(2)
if (!control || !isHostRunId(id || '')) throw new Error('Invalid executor binding')
const directory = path.join(control, 'host-executor')
await mkdir(directory, {recursive:true, mode:0o700})
let input = ''
for await (const chunk of process.stdin) input += chunk
const base = path.join(directory, id)
await writeFile(base+'.tmp', input, {mode:0o600, flag:'wx'})
await rename(base+'.tmp', base+'.request.json')
for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal, () => {
  void writeFile(base+'.cancel', '', {mode:0o600}).finally(() => process.exit(130))
})
let offset = 0
let lastHeartbeat = Date.now()
try {
  for (;;) {
    let content = ''
    try { content = await readFile(base+'.events','utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const end = content.lastIndexOf('\n')+1
    for (const line of content.slice(offset,end).split('\n').filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.stream === 'stdout') process.stdout.write(event.text)
      if (event.stream === 'stderr') process.stderr.write(event.text)
      if (event.stream === 'exit') { process.exitCode=event.code; await rm(base+'.events',{force:true}); process.exit(event.code) }
    }
    offset=end
    // Drain completion first. A brief missing file at the shared-filesystem
    // boundary must not cancel a healthy job or hide its terminal result.
    try {
      const heartbeat = JSON.parse(await readFile(path.join(directory,'heartbeat.json'),'utf8'))
      if (!Number.isFinite(heartbeat.at)) throw new Error('Invalid host CLI heartbeat')
      lastHeartbeat = heartbeat.at
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (Date.now()-lastHeartbeat > 15000) throw new Error('Host CLI executor is offline')
    await new Promise(resolve => setTimeout(resolve,150))
  }
} catch (error) {
  await writeFile(base+'.cancel','',{mode:0o600})
  console.error((error as Error).message)
  process.exitCode=1
}
