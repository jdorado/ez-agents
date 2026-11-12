import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunRecord } from '../src/runs.js'
import { statusReport, type StatusInput } from '../src/status-report.js'

const now = Date.UTC(2026, 10, 7, 12, 0)
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const preset = (cli: string, authProfile: string | undefined, model: string) =>
  ({ id: `${cli}-${authProfile}`, name: cli, cli, ...(authProfile ? { authProfile } : {}), model })
const run = (id: string, change: Partial<RunRecord>): RunRecord => ({ version: 2, id, texts: [], status: 'queued', createdAt: at(1), ...change })
const input = (change: Partial<StatusInput> = {}): StatusInput => ({
  now, runs: [], names: new Map(), system: ['Relay: running · v0.1.0-beta.69', 'Host transport: running · v0.1.0-beta.69'],
  scheduledLimit: 6, incoming: { pending: 0, failed: 0 }, delivery: { failed: [], unknown: [] }, unavailableSources: [], privateChat: true, ...change,
})

test('an idle relay is green and says nothing needs attention', () => {
  const view = statusReport(input())
  assert.equal(view.html, [
    '<b>🟢 Ez · idle</b>', '',
    '<b>▶ Work</b>\nNothing running or queued.', '',
    '<b>System</b>\n<pre>Relay           running · v0.1.0-beta.69\nHost transport  running · v0.1.0-beta.69</pre>',
  ].join('\n'))
  assert.deepEqual([view.stop, view.cancel, view.retry], [false, false, false])
})

test('work, attention and recent failures carry their details, worst-first and capped', () => {
  const execution = (cli: string, profile: string | undefined, model: string) => ({ sessionId: 's', preset: preset(cli, profile, model) })
  const view = statusReport(input({
    names: new Map([['t1', 'daily-brief'], ['t2', 'nightly-sync']]),
    runs: [
      run('a', { status: 'running', startedAt: at(4), scheduled: { id: 't1', revision: 'r', dueAt: at(5), pairedAt: at(999) }, execution: execution('codex', undefined, 'gpt-6-astra'),
        attempts: [{ preset: { ...preset('codex', undefined, 'gpt-6-astra'), authProfile: 'work' }, quotaScope: 'codex@work', outcome: 'running' }] }),
      run('b', { status: 'queued', createdAt: at(12), texts: ['rebalance the <b>portfolio</b> before the market opens'], execution: execution('claude', undefined, 'sonnet') }),
      run('c', { status: 'queued', createdAt: at(3), quotaWait: { retryAt: '11-07 06:00' } as never, scheduled: { id: 't2', revision: 'r', dueAt: at(5), pairedAt: at(999) } }),
      run('d', { status: 'failed', endedAt: at(120), scheduled: { id: 't2', revision: 'r', dueAt: at(130), pairedAt: at(999) }, failure: { error: 'exit 1: market <data> timeout\nstack line', relayVersion: 'v' } }),
      run('e', { status: 'failed', endedAt: at(60 * 30), failure: { error: 'too old', relayVersion: 'v' } }),
      run('f', { status: 'queued', blockReason: 'external-execution-unavailable', scheduled: { id: 't2', revision: 'r', dueAt: at(5), pairedAt: at(999) } }),
    ],
    incoming: { pending: 2, failed: 1 }, delivery: { failed: [at(14), at(2)], unknown: [at(41)] }, unavailableSources: ['feed&1'], waitingRunId: undefined,
  }))
  const lines = view.html.split('\n')
  assert.equal(lines[0], '<b>🟡 Ez · running · 4 need attention</b>')
  assert.ok(lines.includes('▶ <b>daily-brief</b> · running 4m · codex@work · gpt-6-astra'))
  assert.ok(lines.includes('⏳ <b>chat "rebalance the &lt;b&gt;portfolio&lt;…"</b> · queued 12m · claude · sonnet'), view.html)
  assert.ok(view.html.includes('queued 3m · waiting for quota, next check 11-07 06:00'))
  assert.ok(view.html.includes('1 of 6 scheduled · 2 incoming messages waiting'))
  assert.ok(lines.includes('• 2 messages failed to send · oldest 14m ago'))
  assert.ok(lines.includes('• 1 delivery awaiting confirmation · oldest 41m · inspect before retrying'))
  assert.ok(lines.includes('• <b>nightly-sync</b> blocked: isolated execution unavailable'))
  assert.ok(lines.includes('• Event sources unavailable: feed&amp;1'))
  assert.ok(lines.includes('<b>nightly-sync</b> · 2h 0m ago · exit 1: market &lt;data&gt; timeout'))
  assert.ok(lines.includes('1 incoming batch failed'))
  assert.doesNotMatch(view.html, /too old|stack line/)
  // Work comes before attention, failures and system, and the buttons follow what can be acted on.
  const order = ['▶ Work', '⚠ Needs attention', 'Recent failures', 'System'].map(title => view.html.indexOf(title))
  assert.deepEqual(order, [...order].sort((x, y) => x - y))
  assert.deepEqual([view.stop, view.cancel, view.retry], [true, true, true])
})

test('message previews stay out of group chats and a down host turns the headline red', () => {
  const runs = [run('b', { status: 'queued', texts: ['private plan'] })]
  assert.match(statusReport(input({ runs })).html, /chat "private plan"/)
  assert.doesNotMatch(statusReport(input({ runs, privateChat: false })).html, /private plan/)
  assert.match(statusReport(input({ runs, privateChat: false })).html, /chat message/)
  const down = statusReport(input({ system: ['Relay: running · v1', 'Host transport: unavailable'] }))
  assert.match(down.html, /^<b>🔴 Ez · idle · host transport unavailable<\/b>/)
})

test('a long reply drops whole sections from the end and never cuts a tag, and rows cap with a count', () => {
  const many = Array.from({ length: 9 }, (_, index) => run(`r${index}`, { status: 'running', startedAt: at(index + 1), createdAt: at(index + 1) }))
  const capped = statusReport(input({ runs: many }))
  assert.ok(capped.html.includes('+4 more'))
  const plugins = `Plugins: ${Array.from({ length: 400 }, (_, index) => `plugin${index} 0.1.0`).join(', ')}`
  const long = statusReport(input({ system: ['Relay: running · v1', plugins] }))
  assert.ok(long.html.length <= 4096 && long.html.endsWith('\n\n…'), String(long.html.length))
  assert.equal(long.html.split('<pre>').length, long.html.split('</pre>').length)
})

test('a preview cut next to an emoji keeps the whole character', () => {
  // 26 characters, then an astral emoji where the 28-character cut lands.
  const view = statusReport(input({ runs: [run('a', { status: 'queued', texts: ['Please check the portfolio😀 and report'] })] }))
  assert.doesNotMatch(view.html, /\p{Cs}/u, "no lone surrogate")
  assert.ok(view.html.includes('chat "Please check the portfolio😀…"'), view.html)
})
