import { readFileSync } from 'node:fs'

// Capture the loaded package version once; an upgrade must not relabel old processes.
export const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
