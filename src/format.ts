export const escapeHtml = (text: string): string => {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const escapeAttribute = (text: string): string => {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

export const markdownToTelegramHtml = (markdown: string): string => {
  if (!markdown) return ''

  const stashed: string[] = []
  const stash = (content: string): string => {
    const placeholder = `\x00${stashed.length}\x00`
    stashed.push(content)
    return placeholder
  }

  // 1. Stash fenced code blocks (preserve whitespace, escape inner chars)
  let text = markdown
    .replace(/\x00/g, '\uFFFD')
    .replace(/```([a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)```/g, (_match, lang, code) => {
      const escapedCode = escapeHtml(code.replace(/\n$/, ''))
      const langAttr = lang ? ` class="language-${escapeAttribute(lang)}"` : ''
      return stash(`<pre><code${langAttr}>${escapedCode}</code></pre>`)
    })

  // 2. Stash inline code
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    return stash(`<code>${escapeHtml(code)}</code>`)
  })

  // 3. Stash links: [label](url)
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return stash(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`)
  })

  // 4. Escape bare HTML entities in remaining prose
  text = escapeHtml(text)

  // 5. Headers to bold (# Header -> <b>Header</b>)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // 6. Bold: **text** or __text__
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>')

  // 7. Italic: *text* or _text_
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<i>$1</i>')

  // 8. Strikethrough: ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')

  // 9. Restore stashed blocks
  return text.replace(/\x00(\d+)\x00/g, (_match, index) => stashed[Number(index)] ?? '')
}
