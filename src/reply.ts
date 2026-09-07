export const splitTelegramText = (text: string, maxLength = 4_000): string[] => {
  if (!text) return ['I could not produce a reply.']
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const boundary = Math.max(remaining.lastIndexOf('\n', maxLength), remaining.lastIndexOf(' ', maxLength))
    const cut = boundary > 0 ? boundary : maxLength
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
