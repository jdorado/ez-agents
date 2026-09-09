import { ControlStore } from '../../src/control-state.js'
import { RunStore, type RunRecord } from '../../src/runs.js'

export async function ownerRun(controlDir: string, id: string, external?: RunRecord['external']) {
  const control = new ControlStore(controlDir, 900_000)
  if (!(await control.status()).owner) {
    await control.requestPairing(101, 101)
    await control.approveOwner(101)
  }
  const runs = new RunStore(controlDir)
  await runs.create({ id, chatId: 101, telegramUserId: 101, texts: ['test'], external })
  return runs.patch(id, { status: 'running' })
}
