#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { watch } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const registryDir = path.join(root, 'registry')
const packageJsonPath = path.join(root, 'package.json')
const registryUrl = process.env.EZ_LOCAL_REGISTRY || 'http://127.0.0.1:4873/'

const flags = new Set(process.argv.slice(2))
const watchMode = flags.has('--watch')
const syncVm = flags.has('--sync-vm')
const skipTests = flags.has('--skip-tests') || watchMode
const gitTag = flags.has('--git-tag')
const noBump = flags.has('--no-bump')
const explicitBump = watchMode || flags.has('--prerelease') || flags.has('--minor') || flags.has('--major')

const run = (command, commandArgs, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${commandArgs.join(' ')} failed (${code})`))
    })
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readPackage = async () => JSON.parse(await readFile(packageJsonPath, 'utf8'))

const ping = async () => {
  const response = await fetch(new URL('/-/ping', registryUrl))
  if (!response.ok) throw new Error(`registry ping ${response.status}`)
}

const versionOnRegistry = async (name, version) => {
  const response = await fetch(new URL(`/${encodeURIComponent(name).replace('%40', '@')}`, registryUrl), {
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry metadata ${response.status}`)
  const metadata = await response.json()
  return Boolean(metadata?.versions?.[version])
}

const ensureRegistry = async () => {
  try {
    await ping()
    return
  } catch {
    await run('docker', ['compose', '-f', path.join(registryDir, 'docker-compose.yml'), 'up', '-d'])
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await ping()
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error(`Local registry did not become ready at ${registryUrl}`)
}

const publishOnce = async () => {
  await run('node', ['scripts/assert-local-registry.mjs'], {env: {...process.env, npm_config_registry: registryUrl}})
  await ensureRegistry()
  const current = await readPackage()
  let version = current.version
  const already = await versionOnRegistry(current.name, version)

  if (!skipTests) await run('pnpm', ['verify'])

  if (already && noBump) {
    throw new Error(`${current.name}@${version} is already on the local registry. Omit --no-bump.`)
  }

  if (already || explicitBump) {
    const bumpArgs = watchMode || flags.has('--prerelease')
      ? ['prerelease', '--preid', 'dev']
      : flags.has('--minor')
        ? ['minor']
        : flags.has('--major')
          ? ['major']
          : ['patch']
    await run('pnpm', ['version', ...bumpArgs, '--no-git-tag-version'])
    version = (await readPackage()).version
  }

  const npmrcDir = await mkdtemp(path.join(tmpdir(), 'ez-npmrc-'))
  try {
    const host = new URL(registryUrl).host
    await writeFile(path.join(npmrcDir, '.npmrc'), `registry=${registryUrl}\n//${host}/:_authToken=ez-local\n`, { mode: 0o600 })
    const tag = version.includes('-') ? 'dev' : 'latest'
    await run('pnpm', ['publish', '--no-git-checks', '--tag', tag], {
      env: {
        ...process.env,
        EZ_LOCAL_REGISTRY: registryUrl,
        npm_config_registry: registryUrl,
        NPM_CONFIG_USERCONFIG: path.join(npmrcDir, '.npmrc'),
      },
    })
  } finally {
    await rm(npmrcDir, { recursive: true, force: true })
  }

  if (gitTag) {
    await run('git', ['add', 'package.json'])
    await run('git', ['commit', '-m', `Release ${version}`])
    await run('git', ['tag', `v${version}`])
  }

  const advertised = process.env.EZ_VM_REGISTRY || registryUrl
  const distTag = version.includes('-') ? 'dev' : 'latest'
  console.log(`\nPublished ${current.name}@${version}`)
  console.log(`  dist-tag: ${distTag}`)
  console.log(`  pin:      pnpm add ${current.name}@${version} --registry ${advertised}`)
  console.log(`  follow:   pnpm add ${current.name}@${distTag} --registry ${advertised}`)
  console.log(`  vm:       EZ_LOCAL_REGISTRY=${advertised} EZ_PACKAGE_VERSION=${distTag} ./scripts/vm-install.sh`)

  if (syncVm) {
    const host = process.env.EZ_VM_HOST
    const vmRegistry = process.env.EZ_VM_REGISTRY
    if (!host || !vmRegistry) throw new Error('EZ_VM_HOST and EZ_VM_REGISTRY are required for --sync-vm')
    await new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        [host, `EZ_LOCAL_REGISTRY=${vmRegistry} EZ_PACKAGE_VERSION=${distTag} EZ_PACKAGE_NAME=${current.name} bash -s`],
        { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] },
      )
      createReadStream(path.join(root, 'scripts', 'vm-install.sh')).pipe(child.stdin)
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`vm sync failed (${code})`))))
    })
  }

  return version
}

if (watchMode) {
  let pending = null
  let timer = null
  const queue = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (pending) return
      pending = publishOnce()
        .catch((error) => console.error(error))
        .finally(() => {
          pending = null
        })
    }, 1500)
  }
  for (const directory of ['src', 'bin']) {
    watch(path.join(root, directory), { recursive: true }, (_event, filename) => {
      if (!filename || filename.startsWith('.')) return
      console.log(`change: ${directory}/${filename}`)
      queue()
    })
  }
  console.log(`Watching src/ and bin/ → versioned prereleases on ${registryUrl}`)
}

await publishOnce()
