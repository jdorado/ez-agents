import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeHtml, markdownToTelegramHtml } from '../src/format.js'

test('preserves snake_case identifiers and rejects stash placeholder collisions', () => {
  assert.equal(markdownToTelegramHtml('act_smoke_123'), 'act_smoke_123')
  assert.equal(markdownToTelegramHtml('_emphasis_'), '<i>emphasis</i>')
  assert.equal(markdownToTelegramHtml('\x000\x00 `safe`'), '\uFFFD0\uFFFD <code>safe</code>')
})

test('escapes bare HTML characters', () => {
  assert.equal(escapeHtml('foo & bar < baz > qux'), 'foo &amp; bar &lt; baz &gt; qux')
})

test('converts code blocks with language safely', () => {
  const md = 'Here is code:\n```typescript\nconst x = 1 < 2 && 3 > 0;\n```'
  const html = markdownToTelegramHtml(md)
  assert.match(
    html,
    /<pre><code class="language-typescript">const x = 1 &lt; 2 &amp;&amp; 3 &gt; 0;<\/code><\/pre>/,
  )
})

test('converts inline code and bold text', () => {
  const md = 'Run `pnpm verify` for **instant** test results.'
  const html = markdownToTelegramHtml(md)
  assert.equal(html, 'Run <code>pnpm verify</code> for <b>instant</b> test results.')
})

test('converts markdown links and escapes URLs', () => {
  const md = 'Check [Google](https://google.com?q=a&b=c)'
  const html = markdownToTelegramHtml(md)
  assert.equal(html, 'Check <a href="https://google.com?q=a&amp;b=c">Google</a>')
})

test('converts strikethrough and headers', () => {
  const md = '# Title\n~~obsolete~~'
  const html = markdownToTelegramHtml(md)
  assert.match(html, /<b>Title<\/b>/)
  assert.match(html, /<s>obsolete<\/s>/)
})
