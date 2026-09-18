export type IsolationClass = 'isolated' | 'host-capable'

export const isolationTransport = (isolation: IsolationClass): 'local' | 'host' =>
  isolation === 'host-capable' ? 'host' : 'local'

export const parseIsolationClass = (value: string): IsolationClass => {
  if (value !== 'isolated' && value !== 'host-capable') throw new Error('Isolation must be isolated or host-capable')
  return value
}

// Isolated runs the native CLI in the relay. Host-capable reuses the installer UID.
// Unlabeled host transport stays host-capable so existing deployments are not flipped.
export const resolveIsolation = (env: NodeJS.ProcessEnv = process.env): IsolationClass => {
  const labeled = env.EZ_ISOLATION?.trim()
  if (labeled) parseIsolationClass(labeled)
  const transport = env.EZ_EXECUTOR_TRANSPORT?.trim() || ''
  if (env.EZ_CHANNEL_BACKEND_URL?.trim()) {
    if (labeled === 'host-capable' || transport === 'host') throw new Error('Host-capable isolation requires the host native CLI, not a channel backend')
    return labeled ? parseIsolationClass(labeled) : 'isolated'
  }
  const isolation = labeled ? parseIsolationClass(labeled) : transport === 'host' ? 'host-capable' : 'isolated'
  const expected = isolationTransport(isolation)
  if ((transport || expected) !== expected) throw new Error(`Isolation ${isolation} requires EZ_EXECUTOR_TRANSPORT=${expected}`)
  return isolation
}
