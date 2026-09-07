import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const run = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

export const serviceDefinition = (directory: string) => {
  const root = path.resolve(directory)
  if (/[\r\n\0]/.test(root)) throw new Error('Service paths must be single-line values.')
  return { command: 'docker', args: ['compose', '--project-directory', packageRoot,
    '--env-file', path.join(root, 'docker.env'), 'up', '-d', '--wait', 'relay'] }
}

// Docker owns lifecycle. No host-service fallback or provider onboarding here.
export const installService = async (directory: string) => {
  const definition = serviceDefinition(directory)
  const file = path.join(path.resolve(directory), 'docker.env')
  if (!(await lstat(file)).isFile()) throw new Error('docker.env must be a regular file')
  const values = parseEnv(await readFile(file, 'utf8'))
  if (!values.COMPOSE_PROJECT_NAME || !values.EZ_RELAY_ENV_FILE)
    throw new Error('docker.env must bind COMPOSE_PROJECT_NAME and EZ_RELAY_ENV_FILE; see docs/docker-runtime.md')
  await run(definition.command, definition.args)
  return { service: 'relay', runtime: 'docker', project: values.COMPOSE_PROJECT_NAME, active: true }
}
