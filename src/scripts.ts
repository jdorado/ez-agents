import { mkdir, readFile, readdir, writeFile, rename, link, rm, realpath, stat, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { type Owner, sameOwner, validOwner } from './control-state.js'
import { assertId } from './identity.js'

// Registered scripts reference agent-owned code in the workspace. Core keeps
// only the registration: no second source copy, interpreter or dependency setup.
export type ScriptRegistration = {
  version: 1; id: string; revision: string; owner: Owner
  entry: string; interpreter: string; args: string[]; sha256: string
  timeoutSeconds: number; registeredAt: string; updatedAt: string
}
// Captured on the run when an occurrence is queued; the launcher verifies it.
export type ScriptRunRef = { id: string; revision?: string; sha256?: string; args: string[] }

export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 900
export const MAX_SCRIPT_TIMEOUT_SECONDS = 21600
const SCRIPT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

export const assertScriptId = (id: unknown): string => {
  if (typeof id !== 'string' || !SCRIPT_ID.test(id)) throw new Error('Script ID must be 1-64 lowercase letters, digits, _ or -')
  return id
}

export const assertScriptArgs = (args: unknown): string[] => {
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))
    throw new Error('Script arguments must be at most 64 literal strings')
  return args as string[]
}

// An installed interpreter is a bare command resolved on the executor PATH or an
// absolute path. Anything with whitespace or shell syntax is a command string.
export const assertInterpreter = (value: unknown): string => {
  if (typeof value !== 'string' || !(COMMAND.test(value) || (path.isAbsolute(value) && !/[\s\0;&|`$<>()'"\\*?]/.test(value))))
    throw new Error('Interpreter must be an installed command name or absolute path, not a shell command')
  return value
}

export const assertTimeout = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SCRIPT_TIMEOUT_SECONDS)
    throw new Error(`Script timeout must be 1..${MAX_SCRIPT_TIMEOUT_SECONDS} seconds`)
  return value as number
}

export const validScriptRunRef = (value: unknown): value is ScriptRunRef => {
  const ref = value as ScriptRunRef
  try {
    return Boolean(ref) && assertScriptId(ref.id) === ref.id && assertScriptArgs(ref.args) === ref.args &&
      (ref.revision === undefined || (typeof ref.revision === 'string' && /^[a-zA-Z0-9_-]+$/.test(ref.revision))) &&
      (ref.sha256 === undefined || (typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)))
  } catch { return false }
}

// The interpreter must be an installed runtime, not unhashed workspace code.
export const resolveInterpreter = async (interpreter: string, pathValue = process.env.PATH, workspace?: string): Promise<string> => {
  assertInterpreter(interpreter)
  const candidates = path.isAbsolute(interpreter) ? [interpreter]
    // Relative PATH entries would resolve against a different cwd at spawn time.
    : (pathValue ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, interpreter))
  for (const candidate of candidates) {
    let real: string
    try { await access(candidate, fsConstants.X_OK); if (!(await stat(candidate)).isFile()) continue; real = await realpath(candidate) } catch { continue }
    if (workspace && real.startsWith(await realpath(workspace) + path.sep)) throw new Error('Interpreter must be an installed runtime outside the agent workspace')
    return candidate
  }
  throw new Error(`Interpreter ${interpreter} is not installed on the executor PATH`)
}

// Resolve a workspace-relative entry point to its real file inside the workspace.
export const workspaceEntry = async (workspace: string, entry: string): Promise<{ file: string; relative: string }> => {
  if (typeof entry !== 'string' || !entry || entry.includes('\0')) throw new Error('Script entry point is required')
  const root = await realpath(workspace)
  let file: string
  try { file = await realpath(path.resolve(root, entry)) }
  catch { throw new Error('Script entry point does not exist in the agent workspace') }
  if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('Script entry point must be a file inside the agent workspace')
  return { file, relative: path.relative(root, file) }
}

export const fileSha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

const atomic = async (file: string, value: unknown, exclusive = false) => {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    if (exclusive) await link(tmp, file)
    else await rename(tmp, file)
  } finally { await rm(tmp, { force: true }) }
}

export class Scripts {
  private dir: string
  constructor(controlDir: string) { this.dir = path.join(controlDir, 'scripts') }

  async get(id: string): Promise<ScriptRegistration> {
    const s = JSON.parse(await readFile(path.join(this.dir, assertId(assertScriptId(id)) + '.json'), 'utf8')) as ScriptRegistration
    if (s.version !== 1 || s.id !== id || typeof s.revision !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(s.revision) || !validOwner(s.owner) ||
      typeof s.entry !== 'string' || !s.entry || path.isAbsolute(s.entry) || s.entry.split(/[\\/]/).includes('..') ||
      !/^[a-f0-9]{64}$/.test(s.sha256)) throw new Error('Invalid script registration')
    assertInterpreter(s.interpreter); assertScriptArgs(s.args); assertTimeout(s.timeoutSeconds)
    return s
  }

  async owned(id: string, owner: Owner): Promise<ScriptRegistration> {
    let s: ScriptRegistration
    try { s = await this.get(id) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Script ${id} is not registered`)
      throw error
    }
    if (!sameOwner(s.owner, owner)) throw new Error('Script registration is outside this owner binding')
    return s
  }

  async list(owner: Owner): Promise<ScriptRegistration[]> {
    let names: string[]
    try { names = await readdir(this.dir) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: ScriptRegistration[] = []
    for (const name of names.filter(name => /^[a-z0-9][a-z0-9_-]*\.json$/.test(name)).sort()) {
      try { const s = await this.get(name.slice(0, -5)); if (sameOwner(s.owner, owner)) result.push(s) }
      catch { console.error('Unreadable script registration', name) }
    }
    return result
  }

  // Register or explicitly update: hashes the current entry-point bytes.
  async save(input: { id: string; owner: Owner; workspace: string; entry: string; interpreter: string; args: string[]; timeoutSeconds: number; pathValue?: string }, create: boolean): Promise<ScriptRegistration> {
    assertScriptId(input.id)
    if (!validOwner(input.owner)) throw new Error('Script registration requires the paired owner')
    const previous = create ? undefined : await this.owned(input.id, input.owner)
    const { file, relative } = await workspaceEntry(input.workspace, input.entry)
    await resolveInterpreter(assertInterpreter(input.interpreter), input.pathValue, input.workspace)
    const now = new Date().toISOString()
    const s: ScriptRegistration = { version: 1, id: input.id, revision: randomUUID(), owner: input.owner, entry: relative,
      interpreter: input.interpreter, args: assertScriptArgs(input.args), sha256: await fileSha256(file),
      timeoutSeconds: assertTimeout(input.timeoutSeconds), registeredAt: previous?.registeredAt ?? now, updatedAt: now }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try { await atomic(path.join(this.dir, s.id + '.json'), s, create) }
    catch (error) {
      if (create && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Script is already registered; use update')
      throw error
    }
    return s
  }

  async remove(id: string, owner: Owner) {
    await this.owned(id, owner)
    await rm(path.join(this.dir, assertScriptId(id) + '.json'))
  }

  // Executor-side check, immediately before spawn: the queued registration
  // revision must still be current and the entry-point bytes must match it.
  async verifiedInvocation(ref: ScriptRunRef, workspace: string, pathValue?: string) {
    if (!validScriptRunRef(ref) || !ref.revision || !ref.sha256) throw new Error(`Script ${ref?.id ?? ''} was not registered when queued`)
    let s: ScriptRegistration
    try { s = await this.get(ref.id) } catch { throw new Error(`Script ${ref.id} registration is unavailable`) }
    if (s.revision !== ref.revision || s.sha256 !== ref.sha256) throw new Error(`Script ${ref.id} registration changed after this run was queued`)
    const { file } = await workspaceEntry(workspace, s.entry)
    if (await fileSha256(file) !== s.sha256) throw new Error(`Script ${ref.id} entry point changed since registration; inspect it and run an explicit registration update`)
    const command = await resolveInterpreter(s.interpreter, pathValue, workspace)
    return { command, args: [file, ...s.args, ...ref.args], registration: s }
  }
}
