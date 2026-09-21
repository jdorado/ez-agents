import { createLedgerHandler, serveDeliverySocket } from '../../src/delivery-socket.js'

// Serves the relay memory ledger for child-process CLIs (message, react,
// approval, schedule) in tests that do not start a full relay. Handlers run
// in this process, so test-created runs are visible to CLI children through
// the shared-volume socket. Fixtures that start a relay must NOT also serve:
// the relay serves the same path.
export const serveTestLedger = async (
  controlDir: string,
  status: () => { polling: boolean; applicationOnly: boolean; telegramConfigured: boolean; version: string } =
    () => ({ polling: false, applicationOnly: false, telegramConfigured: true, version: 'test' }),
) => {
  const server = await serveDeliverySocket(
    controlDir,
    createLedgerHandler(controlDir, { wake: () => {}, status }),
  )
  return server
}
