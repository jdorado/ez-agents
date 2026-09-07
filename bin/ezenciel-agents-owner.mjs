#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const tsx = require.resolve('tsx')
const entry = join(here, '..', 'src', 'owner.ts')
const forwarded = process.argv.slice(2).filter((arg) => arg !== '--')
const args = existsSync('.env') ? ['--env-file=.env', entry] : [entry]
const child = spawn(process.execPath, ['--import', tsx, ...args, ...forwarded], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
