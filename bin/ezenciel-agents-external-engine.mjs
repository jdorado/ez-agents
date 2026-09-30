#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('../src/external-engine-cli.mjs', import.meta.url));
const child = spawn(process.execPath, ['--import', require.resolve('tsx'), source, ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', () => { console.error('EXTERNAL_ENGINE_UNAVAILABLE'); process.exitCode = 1; });
child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
