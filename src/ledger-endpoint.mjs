// One source for the host-capable ledger overlay: agent creation, the
// deployment migration and its tests must emit the same compose fragment.
export const ledgerOverlayName = 'ledger.compose.yaml'

export const ledgerOverlayYaml = () => [
  '# Host-capable execution: on Docker Desktop/OrbStack the control-volume',
  '# Unix socket is not connectable from the host, so the relay serves its',
  '# memory ledger on this published loopback port and requests authenticate',
  '# with the per-run token in the control directory.',
  'services:',
  '  relay:',
  '    environment:',
  '      EZ_DELIVERY_TCP_PORT: ${EZ_DELIVERY_TCP_PORT:?}',
  '    ports:',
  '      - "127.0.0.1:${EZ_DELIVERY_TCP_PORT:?}:${EZ_DELIVERY_TCP_PORT:?}"',
  '',
].join('\n')
