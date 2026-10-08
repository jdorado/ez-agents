import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// Owner-provisioned named credential homes beside the agent default binding.
// Unset keeps control/cli/<cli>; a name selects control/cli/profiles/<name>/<cli>
// with its own credentials, configuration and native sessions. Ez never stores,
// copies or prints credentials; the native CLI logs in inside the home.
export const AUTH_PROFILE_CLIS: readonly string[] = ['codex', 'claude']
export const isAuthProfile = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)

export const cliHome = (controlDir: string, cli: string, authProfile?: string): string => {
  if (authProfile === undefined) return path.join(controlDir, 'cli', cli)
  if (!isAuthProfile(authProfile) || !AUTH_PROFILE_CLIS.includes(cli)) throw new Error('Invalid auth profile selection')
  return path.join(controlDir, 'cli', 'profiles', authProfile, cli)
}

const realDirectory = (directory: string) => lstat(directory).then(stat => stat.isDirectory(), () => false)

// A named home exists only once the owner provisioned it as a real directory.
// Execution never creates, links or falls back from it.
export const provisionedHome = async (controlDir: string, cli: string, authProfile?: string): Promise<string> => {
  const home = cliHome(controlDir, cli, authProfile)
  if (authProfile !== undefined && !await realDirectory(home)) throw new Error(`Auth profile ${authProfile} is not provisioned for ${cli}`)
  return home
}

export const listAuthProfiles = async (controlDir?: string): Promise<{ cli: string; authProfile: string }[]> => {
  if (!controlDir) return []
  const names = await readdir(path.join(controlDir, 'cli', 'profiles')).catch(() => [] as string[])
  const found: { cli: string; authProfile: string }[] = []
  for (const authProfile of names.filter(isAuthProfile).sort())
    for (const cli of AUTH_PROFILE_CLIS)
      if (await realDirectory(cliHome(controlDir, cli, authProfile))) found.push({ cli, authProfile })
  return found
}

// Claude credentials for one home. Host-capable default homes share the
// installer login in place; named homes and isolated agents use only their
// own store, plus an optional owner-provisioned long-lived `oauth-token`.
export const claudeAuthEnvironment = async (home: string, authProfile?: string, isolated = process.env.EZ_ISOLATION === 'isolated'): Promise<NodeJS.ProcessEnv> => {
  const environment: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: home }
  if (!isolated && authProfile === undefined) environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = ''
  const token = await readFile(path.join(home, 'oauth-token'), 'utf8').then(value => value.trim(), (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (token !== undefined) {
    if (!/^[A-Za-z0-9._-]{20,512}$/.test(token)) throw new Error('Invalid Claude token binding')
    environment.CLAUDE_CODE_OAUTH_TOKEN = token
  }
  return environment
}
