import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'

export type TelegramProvisioningConfig = {
  version: 1
  composeFile: string
  projectDirectory: string
  projectName: string
  service: 'relay'
  relayEnvFile: string
  overrideFile: string
  image: string
}

type ComposeRunner = (args: string[]) => Promise<void>

const botToken = (value: string) => /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value)
const imageReference = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(value)
const projectName = (value: string) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)

const containedBy = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

const absoluteRegularFile = async (file: string, ownerOnly = false): Promise<void> => {
  if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) throw new Error('Provisioning paths must be absolute single-line paths')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Provisioning files must be regular files')
  if (ownerOnly && (info.mode & 0o077)) throw new Error('Provisioning configuration must be owner-only')
}

const privateWrite = async (file: string, content: string) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

const previousFile = async (file: string): Promise<string | null> => {
  try {
    await absoluteRegularFile(file)
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const restoreFile = async (file: string, previous: string | null) => {
  if (previous === null) await rm(file, { force: true })
  else await privateWrite(file, previous)
}

const parseConfig = (value: unknown): TelegramProvisioningConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Telegram provisioning configuration')
  const config = value as Record<string, unknown>
  if (Object.keys(config).sort().join(',') !== 'composeFile,image,overrideFile,projectDirectory,projectName,relayEnvFile,service,version')
    throw new Error('Invalid Telegram provisioning configuration')
  if (config.version !== 1 || config.service !== 'relay' || ![config.composeFile, config.projectDirectory, config.projectName, config.relayEnvFile, config.overrideFile, config.image].every(value => typeof value === 'string'))
    throw new Error('Invalid Telegram provisioning configuration')
  const parsed = config as unknown as TelegramProvisioningConfig
  if (!projectName(parsed.projectName) || !imageReference(parsed.image)) throw new Error('Invalid Telegram provisioning configuration')
  return parsed
}

export const readTelegramProvisioningConfig = async (configFile: string): Promise<TelegramProvisioningConfig> => {
  await absoluteRegularFile(configFile, true)
  const config = parseConfig(JSON.parse(await readFile(configFile, 'utf8')))
  if (!path.isAbsolute(config.projectDirectory) || /[\r\n\0]/.test(config.projectDirectory)) throw new Error('Invalid Telegram provisioning configuration')
  await absoluteRegularFile(config.composeFile)
  for (const file of [config.relayEnvFile, config.overrideFile]) {
    if (!path.isAbsolute(file) || !containedBy(config.projectDirectory, file)) throw new Error('Telegram secrets must remain inside the deployment directory')
  }
  return config
}

const composeOverride = (config: TelegramProvisioningConfig) => [
  'services:',
  '  relay:',
  `    image: ${JSON.stringify(config.image)}`,
  '    secrets:',
  '      - source: relay_env',
  '        target: relay_env',
  'secrets:',
  '  relay_env:',
  `    file: ${JSON.stringify(config.relayEnvFile)}`,
  '',
].join('\n')

const runDockerCompose: ComposeRunner = async (args) => await new Promise<void>((resolve, reject) => {
  const child = spawn('docker', ['compose', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const capture = (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.once('error', reject)
  child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Telegram relay could not start (${code ?? 'unknown'}): ${output.replace(/\s+/g, ' ').trim() || 'no diagnostic'}`)))
})

const composeArguments = (config: TelegramProvisioningConfig, includeOverride: boolean) => [
  '--project-directory', config.projectDirectory,
  '--project-name', config.projectName,
  '-f', config.composeFile,
  ...(includeOverride ? ['-f', config.overrideFile] : []),
  'up', '-d', '--wait', config.service,
]

export const provisionTelegramBot = async (
  configFile: string,
  token: string,
  runCompose: ComposeRunner = runDockerCompose,
): Promise<void> => {
  if (!botToken(token)) throw new Error('Invalid Telegram bot token')
  const config = await readTelegramProvisioningConfig(configFile)
  const lock = path.join(config.projectDirectory, 'telegram-provisioning.lock')
  try {
    await writeFile(lock, '', { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Telegram setup is already in progress')
    throw error
  }

  const previousSecret = await previousFile(config.relayEnvFile)
  const previousOverride = await previousFile(config.overrideFile)
  try {
    await privateWrite(config.relayEnvFile, `TELEGRAM_BOT_TOKEN=${token}\n`)
    await privateWrite(config.overrideFile, composeOverride(config))
    await runCompose(composeArguments(config, true))
  } catch (error) {
    await restoreFile(config.relayEnvFile, previousSecret)
    await restoreFile(config.overrideFile, previousOverride)
    try { await runCompose(composeArguments(config, false)) } catch { /* Preserve the original failure while attempting rollback. */ }
    throw error
  } finally {
    await rm(lock, { force: true })
  }
}
