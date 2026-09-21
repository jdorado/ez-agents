import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type DetectedFileType = 'pdf' | 'jpeg' | 'png' | 'webp' | 'text' | 'unknown'

export const detectFileType = (buffer: Buffer): DetectedFileType => {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'pdf'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (!buffer.includes(0)) return 'text'
  } catch {}
  return 'unknown'
}

export const sanitizeFileName = (name: string): string => {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'file'
}

// Runtime inbound staging lives under the agent control directory, never the
// workspace mind folder. The engine resolves the absolute path regardless of
// its working directory; the prompt carries no workspace-relative prefix.
export const stageIncomingFile = async (
  stagingRoot: string,
  fileName: string,
  bytes: Buffer,
): Promise<{ relativePath: string; fullPath: string; fileType: DetectedFileType }> => {
  const fileType = detectFileType(bytes)
  if (fileType === 'unknown' || bytes.length > 20 * 1024 * 1024)
    throw new Error('Unsupported or oversized attachment')
  const attachmentsDir = path.join(stagingRoot, 'attachments')
  await mkdir(attachmentsDir, { recursive: true, mode: 0o700 })
  const sanitized = sanitizeFileName(fileName)
  const targetName = `${randomUUID()}_${sanitized}`
  await workspaceFile(stagingRoot, 'attachments', false)
  const fullPath = path.join(attachmentsDir, targetName)
  await writeFile(fullPath, bytes, { mode: 0o600 })
  return {
    relativePath: path.join('attachments', targetName),
    fullPath,
    fileType,
  }
}

// Reads a staged attachment produced by stageIncomingFile. Relative paths
// resolve under the first containing root (backward compatible with
// workspace inbox staging); absolute paths must stay inside one of the roots.
export const readStagedAttachment = async (roots: (string | undefined)[], file: string): Promise<Buffer> => {
  const candidates = [...new Set(roots.filter((root): root is string => Boolean(root)))]
  if (!path.isAbsolute(file)) {
    for (const root of candidates) {
      try { return await readFile(await workspaceFile(root, file)) } catch {}
    }
    throw new Error('File is outside the workspace')
  }
  const target = await realpath(file).catch(() => { throw new Error('File is outside the workspace') })
  for (const root of candidates) {
    const base = await realpath(root).catch(() => null)
    if (!base) continue
    const relative = path.relative(base, target)
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative !== '') {
      if (!(await stat(target)).isFile()) throw new Error('Expected a regular file')
      return readFile(target)
    }
  }
  throw new Error('File is outside the workspace')
}

export const workspaceFile = async (workspace: string, file: string, regular = true): Promise<string> => {
  const root = await realpath(workspace)
  const target = await realpath(path.resolve(root, file))
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('File is outside the workspace')
  if (regular && !(await stat(target)).isFile()) throw new Error('Expected a regular file')
  return target
}

// Canonical native-engine attachment metadata for every inbound channel.
export const MAX_INCOMING_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const stageChatAttachment = async (stagingRoot: string, name: string, bytes: Buffer, comment: string) => {
  const type = detectFileType(bytes)
  if (!bytes.length || bytes.length > MAX_INCOMING_ATTACHMENT_BYTES || type === 'unknown' ||
    (type === 'text' && !/\.(txt|md|markdown)$/i.test(name))) throw new Error('Invalid application attachment: unsupported type or size')
  const staged = await stageIncomingFile(stagingRoot, name, bytes)
  const kind = ['jpeg', 'png', 'webp'].includes(staged.fileType) ? 'image' : 'document'
  return { text: `[Attached ${kind} staged at ${staged.fullPath} (type: ${staged.fileType}, size: ${bytes.length} bytes)]${comment ? `\n\nCaption: ${comment}` : ''}`,
    attachment: {path: staged.fullPath, type: staged.fileType}, fullPath: staged.fullPath }
}
