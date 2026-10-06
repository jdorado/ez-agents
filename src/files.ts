import { mkdir, readFile, writeFile, realpath, stat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type DetectedFileType = 'pdf' | 'jpeg' | 'png' | 'webp' | 'text' | 'mp4' | 'unknown'

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
  if (buffer.length >= 12 && buffer.subarray(4,8).toString('ascii') === 'ftyp') return 'mp4'
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
  const kind = ['jpeg', 'png', 'webp'].includes(staged.fileType) ? 'image' : staged.fileType === 'mp4' ? 'video' : 'document'
  return { text: `[Attached ${kind} staged at ${staged.fullPath} (type: ${staged.fileType}, size: ${bytes.length} bytes)]${comment ? `\n\nCaption: ${comment}` : ''}`,
    attachment: {path: staged.fullPath, type: staged.fileType}, fullPath: staged.fullPath }
}

// Shared inbound staging/validation with Telegram; restricted correspondence
// can read only this already-authorized input, never arbitrary workspace paths.
export async function readChatAttachment(stagingRoot: string, name: string, bytes: Buffer) {
  const staged = await stageChatAttachment(stagingRoot, name, bytes, '')
  try {
    if (['jpeg','png','webp'].includes(staged.attachment.type)) return {name:sanitizeFileName(name),type:staged.attachment.type,bytes:bytes.length,image:{data:bytes.toString('base64'),mimeType:`image/${staged.attachment.type}`}}
    if (staged.attachment.type === 'mp4') {
      const directory = await mkdtemp(path.join(stagingRoot,'video-'))
      try {
        const execute = promisify(execFile)
        const probe = JSON.parse((await execute('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',staged.fullPath],{timeout:3000,maxBuffer:8000})).stdout)
        const durationSeconds = Number(probe.format?.duration)
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120 || !probe.streams?.some((stream:{codec_type:string})=>stream.codec_type==='video')) throw Error('Video must contain a visual track and be at most 120 seconds')
        await execute('ffmpeg',['-v','error','-nostdin','-protocol_whitelist','file,pipe','-enable_drefs','0','-use_absolute_path','0','-i',staged.fullPath,'-an','-vf',`fps=fps=${8/durationSeconds}:start_time=0,scale=640:-2`,'-frames:v','8','-q:v','3',path.join(directory,'frame-%02d.jpg')],{timeout:20000,maxBuffer:8000})
        const names=(await readdir(directory)).filter(name=>/^frame-\d{2}\.jpg$/.test(name)).sort()
        const images=[];let total=0
        for (const frame of names) {
          const image=await readFile(path.join(directory,frame));total+=image.length
          if (total>1024*1024 || detectFileType(image)!=='jpeg') throw Error('Video frames exceed the bounded image limit')
          images.push({data:image.toString('base64'),mimeType:'image/jpeg'})
        }
        if (!images.length) throw Error('Video has no decodable frames')
        return {name:sanitizeFileName(name),type:'mp4',bytes:bytes.length,durationSeconds,frames:images.map((_,index)=>({frame:index+1,seconds:index*durationSeconds/8})),images}
      } finally { await rm(directory,{recursive:true,force:true}) }
    }
    const limit = 256000
    const text = staged.attachment.type === 'text' ? new TextDecoder('utf-8', {fatal:true}).decode(bytes)
      : (await promisify(execFile)('pdftotext', ['-enc','UTF-8','-layout',staged.fullPath,'-'], {timeout:20000,maxBuffer:limit})).stdout
    if (!text.trim()) throw Error('Document has no extractable text; scanned PDFs require OCR')
    if (Buffer.byteLength(text) > limit) throw Error('Extracted document exceeds the 256000-byte text limit')
    return { name: sanitizeFileName(name), type: staged.attachment.type, bytes: bytes.length, text }
  } finally { await unlink(staged.fullPath) }
}
