#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),require=createRequire(import.meta.url),tsx=require.resolve('tsx'),entry=join(here,'..','src','workforce-watch-cli.ts')
const child=spawn(process.execPath,['--import',tsx,entry],{stdio:'inherit'})
child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);process.exit(code??1)})
