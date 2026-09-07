#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const entry = join(here, '..', 'src', 'index.ts')
const forwarded = process.argv.slice(2).filter((arg) => arg !== '--')
if (forwarded.length === 1 && forwarded[0] === '--version') {
  console.log(require('../package.json').version)
  process.exit(0)
}
if (forwarded.length === 1 && ['--help', '-h'].includes(forwarded[0])) {
  console.log('Usage: ezenciel-agents [start]\nStarts the Docker relay bound by EZ_DEPLOYMENT_DIR/docker.env.\nInitialize the mind: ezenciel-agents-setup init\nSetup instructions: docs/setup.md in the installed package.')
  process.exit(0)
}
if (forwarded.length && (forwarded.length !== 1 || forwarded[0] !== 'start')) {
  console.error('Usage: ezenciel-agents [start] (or --help)')
  process.exit(1)
}
if (!existsSync('/.dockerenv') && process.env.EZ_DEVELOPMENT !== '1') {
  const docker = spawn(join(here, 'ezenciel-agents-docker'), ['up', '-d', '--wait', 'relay'], { stdio: 'inherit' })
  docker.on('error', () => { console.error('Docker launcher could not start'); process.exitCode = 1 })
  docker.on('exit', code => { process.exitCode = code ?? 1 })
} else {
const tsx = require.resolve('tsx')
const args = existsSync('.env') ? ['--env-file=.env', entry] : [entry]
const child = spawn(process.execPath, ['--import', tsx, ...args, ...forwarded], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})

}
