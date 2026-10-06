import {execFileSync} from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pcmToWav, encodeOggOpus, transcribeAudio, synthesizeSpeech, SpeechCreditsDepletedError } from '../src/audio.js'

test('speech reports depleted credits without exposing provider details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 402 }))
  await assert.rejects(synthesizeSpeech('Fixture', { geminiApiKey: 'fixture-key' }), SpeechCreditsDepletedError)
})

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
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls += 1
    assert.match(url, /gemini-3\.8-flash-lite-tts:generateContent$/)
    assert.equal(url.includes('fixture-key'), false)
    assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'fixture-key')
    const config = JSON.parse(String(options.body)).generationConfig
    assert.deepEqual(config.responseFormat, { audio: { mimeType: 'AUDIO_L16', sampleRate: 24000 } })
    assert.deepEqual(config.speechConfig.voiceConfig, { voice: calls === 3 ? 'voice_r3yhwvxvihxg' : 'Kore' })
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
  const wav = await synthesizeSpeech('Fixture', { geminiApiKey: 'fixture-key', format: 'wav' })
  assert.equal(wav.mimeType, 'audio/wav')
  assert.equal(wav.buffer.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.buffer.length, 24044)
  await synthesizeSpeech('Fixture', { geminiApiKey: 'fixture-key', voice: 'voice_r3yhwvxvihxg', format: 'wav' })
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


test('OpenRouter uses the existing renderer and encoder for real Ogg Opus and WAV without provider fallback', async t => {
  const mp3=execFileSync('ffmpeg',['-f','s16le','-ar','24000','-ac','1','-i','pipe:0','-f','mp3','pipe:1'],{input:Buffer.alloc(48000),stdio:['pipe','pipe','ignore']})
  t.mock.method(globalThis,'fetch',async (url:string,options:RequestInit) => {
    assert.equal(url,'https://openrouter.ai/api/v1/audio/speech')
    assert.equal(new Headers(options.headers).get('authorization'),'Bearer fixture-key')
    assert.deepEqual(JSON.parse(String(options.body)),{model:'fish-audio/s2.1-pro-free:free',input:'Fixture',response_format:'mp3'})
    return new Response(mp3,{headers:{'content-type':'audio/mpeg'}})
  })
  const options={speechProvider:'openrouter' as const,openrouterApiKey:'fixture-key',geminiApiKey:'unused'}
  const ogg=await synthesizeSpeech('Fixture',options)
  assert.equal(ogg.mimeType,'audio/ogg');assert.equal(ogg.buffer.subarray(0,4).toString(),'OggS');assert.ok(ogg.buffer.includes(Buffer.from('OpusHead')))
  const wav=await synthesizeSpeech('Fixture',{...options,format:'wav'})
  assert.equal(wav.buffer.subarray(0,4).toString(),'RIFF');assert.equal(wav.buffer.readUInt32LE(24),24000)
  t.mock.method(globalThis,'fetch',async () => new Response('private provider detail',{status:429}))
  await assert.rejects(synthesizeSpeech('Fixture',options), /error 429/)
})
