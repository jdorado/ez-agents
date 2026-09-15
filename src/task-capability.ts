import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { executorEnvironment } from './executor.js'
import type { TaskCapability } from './tasks.js'

const execute = promisify(execFile)

export async function assertChannelQuery(toolsHome: string | undefined, capability: TaskCapability) {
  if (!toolsHome || !path.isAbsolute(toolsHome)) throw new Error('Channel capabilities require an installed tool registry')
  const registry = JSON.parse(await readFile(path.join(toolsHome,'registry.json'),'utf8')) as {
    commands?: Record<string,string>, plugins?: Record<string,{manifest?:{commands?:Record<string,{channelQuery?:boolean,exposure?:Record<string,boolean>}>}}>
  }
  const command = registry.plugins?.[registry.commands?.[capability.command] ?? '']?.manifest?.commands?.[capability.command]
  const exposure = command?.exposure
  if (command?.channelQuery !== true || exposure?.receivesExternalContent !== true || exposure.sendsExternally !== false ||
      exposure.changesRecords !== false || exposure.requiresReview !== false)
    throw new Error(`Capability ${capability.id} is not an installed read-only channel query`)
}

export async function runTaskCapability(toolsHome: string | undefined, capability: TaskCapability, input: string) {
  await assertChannelQuery(toolsHome,capability)
  const home = toolsHome!
  const args = [capability.command, ...capability.args.map(value => value === '{input}' ? input : value)]
  let stdout = '', code = 0
  try {
    const result = await execute(path.join(home,'bin','ez'),args,{encoding:'utf8',env:executorEnvironment(),timeout:15000,maxBuffer:131072})
    stdout = result.stdout
  } catch (error) {
    const failure = error as Error & {stdout?:string;code?:number|string}
    stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
    code = typeof failure.code === 'number' ? failure.code : 1
  }
  if (Buffer.byteLength(stdout) > 131072) throw new Error('Channel capability output is too large')
  if (code !== 0 || !stdout.trim()) throw new Error(`Channel capability failed with exit ${code}`)
  return {output:stdout}
}
