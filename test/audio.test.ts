import test from 'node:test'
import assert from 'node:assert/strict'
import { pcmToWav, encodeOggOpus, transcribeAudio, synthesizeSpeech } from '../src/audio.js'

test('speech provider failure stays a failure, never a text or WAV success', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })),
  )
  await assert.rejects(synthesizeSpeech('Fixture', { geminiApiKey: 'fixture-key' }), /no audio data/)
})

test('speech finds audio beyond the first response part and keeps credentials out of URLs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url.includes('fixture-key'), false)
    assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'fixture-key')
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'metadata' },
                {
                  inlineData: {
                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                    data: Buffer.alloc(24000).toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      }),
    )
  })
  const speech = await synthesizeSpeech('Fixture', { geminiApiKey: 'fixture-key' })
  assert.equal(speech.mimeType, 'audio/ogg')
  assert.equal(speech.buffer.subarray(0, 4).toString(), 'OggS')
})

test('pcmToWav generates a valid 44-byte WAV header', () => {
  const pcm = Buffer.alloc(24000 * 2) // 1 second of silence
  const wav = pcmToWav(pcm, 24000, 1)

  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE')
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ')
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data')
  assert.equal(wav.length, pcm.length + 44)
})

test('encodeOggOpus produces actual Ogg Opus, never a disguised WAV', async () => {
  const pcm = Buffer.alloc(24000 * 2)
  const encoded = await encodeOggOpus(pcm, 24000, 1)

  assert.ok(encoded.length > 0)
  const magic = encoded.subarray(0, 4).toString('ascii')
  assert.equal(magic, 'OggS')
})

test('transcribeAudio rejects when no API keys are provided', async () => {
  const dummyAudio = Buffer.from('not real audio')
  await assert.rejects(
    () => transcribeAudio(dummyAudio, 'audio/ogg', { geminiApiKey: '', openaiApiKey: '' }),
    /No audio transcription API key configured/,
  )
})

test('synthesizeSpeech rejects empty text', async () => {
  await assert.rejects(
    () => synthesizeSpeech('   ', { geminiApiKey: 'test' }),
    /Cannot synthesize speech for empty text/,
  )
})
