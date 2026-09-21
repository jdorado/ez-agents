import { readFileSync } from 'node:fs'

// Capture the loaded package version once; an upgrade must not relabel old processes.
export const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// Optional image build identity (tag + commit), baked by Docker builds that pass
// BUILD_TAG/BUILD_SHA. Absent for source checkouts and CI builds without args.
export const buildInfo: { tag?: string; sha?: string } = (() => {
  try {
    const info = JSON.parse(readFileSync(new URL('../build.json', import.meta.url), 'utf8'))
    const tag = typeof info.tag === 'string' && info.tag ? info.tag : undefined
    const sha = typeof info.sha === 'string' && info.sha ? info.sha : undefined
    return { ...(tag ? { tag } : {}), ...(sha ? { sha } : {}) }
  } catch { return {} }
})()

export const formatRelayLabel = (version: string, tag?: string, sha?: string): string => {
  const short = sha && sha.length > 12 ? sha.slice(0, 12) : sha
  if (tag) return `${tag} (v${version}${short ? ` · ${short}` : ''})`
  return short ? `v${version} (${short})` : `v${version}`
}

export const relayVersionLabel = (): string =>
  formatRelayLabel(packageVersion, buildInfo.tag, buildInfo.sha)
