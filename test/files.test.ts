import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { detectFileType, sanitizeFileName, stageIncomingFile } from '../src/files.js'

test('detects PDF magic bytes correctly', () => {
  const pdfHeader = Buffer.from('%PDF-1.7 ... dummy content')
  assert.equal(detectFileType(pdfHeader), 'pdf')
})

test('detects JPEG magic bytes correctly', () => {
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  assert.equal(detectFileType(jpegHeader), 'jpeg')
})

test('detects PNG magic bytes correctly', () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(detectFileType(pngHeader), 'png')
})

test('detects WebP magic bytes correctly', () => {
  const webpHeader = Buffer.from('RIFF....WEBPVP8 ...', 'ascii')
  assert.equal(detectFileType(webpHeader), 'webp')
})

test('detects plain text and rejects binary unknown', () => {
  assert.equal(detectFileType(Buffer.from('hello world')), 'text')
  assert.equal(detectFileType(Buffer.from([0x00, 0x01, 0x02])), 'unknown')
})

test('sanitizes dangerous file names', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('report 2026!@#.pdf'), 'report_2026___.pdf')
})

test('stages file into workspace inbox cleanly', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ez-files-'))
  try {
    const data = Buffer.from('%PDF-1.4 sample content')
    const staged = await stageIncomingFile(tmp, 'sample.pdf', data)
    assert.equal(staged.fileType, 'pdf')
    assert.match(staged.relativePath, /^inbox[/\\][a-f0-9-]+_sample\.pdf$/)
    const read = await readFile(staged.fullPath)
    assert.deepEqual(read, data)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
