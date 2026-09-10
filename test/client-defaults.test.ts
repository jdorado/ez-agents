import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverDefaults, grokSettings, resolvedCodexDefaults } from '../src/client-defaults.js'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, statusPreset } from '../src/ai.js'

test('discovery projects configured choices only; no credentials or guessed wrapper defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ez-defaults-'))
  try {
    await mkdir(join(home, '.grok'))
    await writeFile(join(home, '.grok/config.toml'), '[models]\ndefault = "fixture-grok"\ndefault_reasoning_effort = "high"\n[other]\ndefault="wrong"')
    await mkdir(join(home, '.claude'))
    await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ model: 'fixture-claude', effortLevel: 'medium', apiKey: 'fixture-secret' }))
    const choices = await discoverDefaults(home, {
      home, codexHome: '/agent/control/cli/codex', available: async () => true,
      codex: async (_cwd, codexHome) => {
        assert.equal(codexHome, '/agent/control/cli/codex')
        return { model: 'fixture-codex', effort: 'low', apiKey: 'fixture-secret' }
      },
      run: async () => JSON.stringify({ model: 'fixture/provider', token: 'fixture-secret' }),
    })
    assert.deepEqual(choices.map(({ cli, model, effort }) => ({ cli, model, effort })), [
      { cli: 'grok', model: 'fixture-grok', effort: 'high' },
      { cli: 'codex', model: 'fixture-codex', effort: 'low' },
      { cli: 'claude', model: 'fixture-claude', effort: 'medium' },
      { cli: 'opencode', model: 'fixture/provider', effort: undefined },
      { cli: 'codex-gui', model: undefined, effort: undefined },
    ])
    assert.ok(!JSON.stringify(choices).includes('fixture-secret'))
    assert.ok(choices.every((p) => /^detected_[a-z0-9]+$/.test(p.id)))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Codex config defaults fall back to its native default-model catalog', () => {
  const catalog = [
    { id: 'fast', model: 'gpt-fast', defaultReasoningEffort: 'low' },
    { id: 'default', model: 'gpt-default', defaultReasoningEffort: 'medium', isDefault: true },
  ]
  assert.deepEqual(resolvedCodexDefaults({}, catalog), { model: 'gpt-default', effort: 'medium' })
  assert.deepEqual(resolvedCodexDefaults({ model: 'gpt-fast' }, catalog), { model: 'gpt-fast', effort: 'low' })
  assert.deepEqual(resolvedCodexDefaults({ model: 'custom', model_reasoning_effort: 'high' }, catalog),
    { model: 'custom', effort: 'high' })
})

test('native Codex fallback is opt-in so setup does not pin a client default', async () => {
  const codex = async (_cwd: string, _home?: string, nativeFallback = false) =>
    nativeFallback ? { model: 'native-default', effort: 'medium' } : {}
  const options = { available: async (cli: string) => cli === 'codex', codex }
  assert.equal((await discoverDefaults('/tmp', options))[0]?.model, undefined)
  assert.equal((await discoverDefaults('/tmp', { ...options, nativeCodexFallback: true }))[0]?.model, 'native-default')
})

test('missing clients are excluded; unavailable metadata stays client default', async () => {
  const choices = await discoverDefaults('/tmp', { available: async (cli) => cli === 'opencode',
    run: async () => { throw new Error('No metadata') } })
  assert.equal(choices.length, 1)
  assert.equal(choices[0].model, undefined)
  assert.match(choices[0].name, /client default/)
  assert.deepEqual(grokSettings('[other]\ndefault="wrong"'), { model: undefined, effort: undefined })
  assert.deepEqual(grokSettings('[models]\ndefault="fixture" # comment\n'), { model: 'fixture', effort: undefined })
})

test('status projects the native client default without pinning the seed', () => {
  const initial = { ...initialPreset('codex'), model: undefined, effort: undefined }
  const discovered = { id: 'detected_codex', name: 'codex · fixture', cli: 'codex', model: 'fixture-codex', effort: 'medium' }
  assert.deepEqual(statusPreset(initial, [discovered]), discovered)
  assert.deepEqual(statusPreset({ ...initial, id: 'detected_empty' }, [discovered]), discovered)
  const explicit = { ...discovered, id: 'saved', model: 'chosen-codex', effort: 'high' }
  assert.equal(statusPreset(explicit, [discovered]), explicit)
  assert.equal(statusPreset(initialPreset('codex-gui'), [{ ...discovered, cli: 'codex-gui' }]).model, 'gpt-5.6-terra')
})

test('seed uses the configured executor; repeated refresh preserves current/default and queued snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-seed-'))
  try {
    const control = new ControlStore(dir, 1000)
    const initial = initialPreset('grok')
    const first = { id: 'detected_first', name: 'Fixture', cli: 'grok', model: 'fixture-v1', effort: 'high' }
    const second = { ...first, id: 'detected_second', model: 'fixture-v2' }
    await control.syncClientPresets(initial, [first])
    const before = await control.captureChoice(initial)
    assert.equal(before.preset.id, first.id)
    await control.syncClientPresets(initial, [second])
    await control.syncClientPresets(initial, [second])
    const after = await control.aiState(initial)
    assert.equal(after.selectedId, first.id)
    assert.equal(after.defaultId, first.id)
    assert.equal(after.presets.length, 2)
    assert.deepEqual(await control.captureChoice(initial), before)
    assert.equal((await control.executionSession(before)).cli, 'grok')
    await assert.rejects(control.syncClientPresets(initial, [{ ...second, cli: 'sh' }]), /Invalid discovered/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
