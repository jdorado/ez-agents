const registry = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || ''
const allowed = process.env.EZ_LOCAL_REGISTRY || 'http://127.0.0.1:4873/'

const allowedHosts = new Set(['127.0.0.1:4873', 'localhost:4873'])
try {
  allowedHosts.add(new URL(allowed).host)
} catch {
  throw new Error(`EZ_LOCAL_REGISTRY is not a URL: ${allowed}`)
}

let host = ''
try {
  host = new URL(registry).host
} catch {
  host = ''
}

if (!host || !allowedHosts.has(host)) {
  throw new Error(
    `Refusing to publish outside the local ez registry. Received ${registry || '(no registry)'}. Use pnpm publish:local.`,
  )
}
