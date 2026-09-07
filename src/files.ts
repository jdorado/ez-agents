import { mkdir, writeFile, realpath, stat } from 'node:fs/promises'
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

export const stageIncomingFile = async (
  workspaceDir: string,
  fileName: string,
  bytes: Buffer,
): Promise<{ relativePath: string; fullPath: string; fileType: DetectedFileType }> => {
  const fileType = detectFileType(bytes)
  if (fileType === 'unknown' || bytes.length > 20 * 1024 * 1024)
    throw new Error('Unsupported or oversized attachment')
  const inboxDir = path.join(workspaceDir, 'inbox')
  await mkdir(inboxDir, { recursive: true, mode: 0o700 })
  const sanitized = sanitizeFileName(fileName)
  const targetName = `${randomUUID()}_${sanitized}`
  await workspaceFile(workspaceDir, 'inbox', false)
  const fullPath = path.join(inboxDir, targetName)
  await writeFile(fullPath, bytes, { mode: 0o600 })
  return {
    relativePath: path.join('inbox', targetName),
    fullPath,
    fileType,
  }
}

export const workspaceFile = async (workspace: string, file: string, regular = true): Promise<string> => {
  const root = await realpath(workspace)
  const target = await realpath(path.resolve(root, file))
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('File is outside the workspace')
  if (regular && !(await stat(target)).isFile()) throw new Error('Expected a regular file')
  return target
}
