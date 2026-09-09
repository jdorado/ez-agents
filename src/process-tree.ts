import { readdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type ProcessInfo = {parent: number; birth: string}
type Snapshot = Map<number, ProcessInfo>

export const matchingProcessIds = (original: Snapshot, current: Snapshot): number[] =>
  [...original].filter(([pid, info]) => info.birth && current.get(pid)?.birth === info.birth).map(([pid]) => pid)

export const processSnapshot = async (): Promise<Snapshot> => {
  if (process.platform === 'win32') return new Map()
  if (process.platform !== 'linux') {
    const {stdout} = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {timeout: 2000})
    return new Map(stdout.trim().split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      return match ? [[Number(match[1]), {parent:Number(match[2]),birth:match[3]}] as const] : []
    }))
  }
  const scan = async (): Promise<Snapshot> => new Map(await Promise.all(
    (await readdir('/proc')).filter(id => /^\d+$/.test(id)).map(async id => {
      const stat = await readFile(`/proc/${id}/stat`, {encoding:'utf8',signal:AbortSignal.timeout(2000)}).catch(() => '')
      const fields = stat.slice(stat.lastIndexOf(')')+2).split(' ')
      return [Number(id), {parent:Number(fields[1]),birth:fields[19] || ''}] as const
    }),
  ))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([scan(), new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new Error('Process inspection timed out')),2000)
    })])
  } finally { clearTimeout(timer) }
}
