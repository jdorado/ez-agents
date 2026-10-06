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

test('stages file into control attachments, never the workspace', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ez-files-'))
  try {
    const data = Buffer.from('%PDF-1.4 sample content')
    const staged = await stageIncomingFile(tmp, 'sample.pdf', data)
    assert.equal(staged.fileType, 'pdf')
    assert.match(staged.relativePath, /^attachments[/\\][a-f0-9-]+_sample\.pdf$/)
    const read = await readFile(staged.fullPath)
    assert.deepEqual(read, data)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('shared incoming document reader extracts PDF text and removes its staged file', async t => {
  const {readChatAttachment}=await import('../src/files.js')
  const {execFile}=await import('node:child_process'), {promisify}=await import('node:util')
  try { await promisify(execFile)('pdftotext',['-v']) } catch { t.skip('Poppler is exercised in the Docker artifact test');return }
  const dir=await mkdtemp('/tmp/ez-pdf-read-');t.after(()=>rm(dir,{recursive:true,force:true}))
  const stream='BT /F1 12 Tf 20 80 Td (Shop opens at 7am.) Tj ET'
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf='%PDF-1.4\n';const offsets=[0]
  for(const [i,value] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`}
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const result=await readChatAttachment(dir,'shop.pdf',Buffer.from(pdf));assert.match(result.text ?? '',/Shop opens at 7am\./);assert.equal(result.type,'pdf')
  const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(path.join(dir,'attachments')),[])
  await assert.rejects(readChatAttachment(dir,'invalid.pdf',Buffer.from('%PDF-invalid')))
})

test('shared image read returns original pixels with native MIME and no staged residue',async t=>{
 const {readChatAttachment}=await import('../src/files.js'),{readdir}=await import('node:fs/promises')
 const dir=await mkdtemp('/tmp/ez-image-read-');t.after(()=>rm(dir,{recursive:true,force:true}))
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')
 const result=await readChatAttachment(dir,'photo.png',png)
 assert.equal(result.image?.mimeType,'image/png');assert.equal(result.image?.data,png.toString('base64'));assert.equal(result.text,undefined)
 assert.deepEqual(await readdir(path.join(dir,'attachments')),[])
 await assert.rejects(readChatAttachment(dir,'photo.png',Buffer.from('Spoofed image bytes')))
})

test('video read uses bounded native frames and removes temporary decoder files',async t=>{
 const {readChatAttachment}=await import('../src/files.js'),{readdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util')
 const execute=promisify(execFile)
 try {await execute('ffmpeg',['-version'])}catch{t.skip('FFmpeg is exercised in the Docker artifact test');return}
 const dir=await mkdtemp('/tmp/ez-video-read-');t.after(()=>rm(dir,{recursive:true,force:true}))
 const video=path.join(dir,'fixture.mp4')
 await execute('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=8','-f','lavfi','-i','sine=frequency=1000:sample_rate=24000','-t','1','-c:v','mpeg4','-c:a','aac',video])
 const result=await readChatAttachment(dir,'video.mp4',await readFile(video))
 assert.equal(result.type,'mp4');assert.ok((result.images?.length??0)>0);assert.ok((result.images?.length??0)<=8)
 assert.ok(result.images?.every(image=>image.mimeType==='image/jpeg'));assert.ok(result.durationSeconds!<=120)
 assert.deepEqual(await readdir(path.join(dir,'attachments')),[]);assert.ok(!(await readdir(dir)).some(name=>name.startsWith('video-')))
})
