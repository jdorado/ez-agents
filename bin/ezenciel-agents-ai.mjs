#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/ai-cli.ts',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit'})
child.on('exit',code=>{process.exitCode=code??1})
