import { RunStore } from '../src/runs.js'

// Called only after the deployment's kernel writer lock is held. No worker
// from a previous container can still own this deployment; PIDs may be reused.
export const recoverInterruptedRuns = async (controlDir: string) => {
  const store = new RunStore(controlDir)
  for (const run of await store.list()) {
    if (run.status === 'running')
      await store.patch(run.id, { status: 'failed', endedAt: new Date().toISOString() })
  }
}
