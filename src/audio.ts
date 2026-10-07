import { spawn } from 'node:child_process'
import { readRequest } from './read-request.js'
import { executorEnvironment, executorInvocation } from './executor.js'

export type AudioOptions = {
  geminiApiKey?: string
  openaiApiKey?: string
  voice?: string
  speechProvider?: 'gemini' | 'openrouter'
  speechModel?: string
  openrouterApiKey?: string
  signal?: AbortSignal
}

export class SpeechCreditsDepletedError extends Error {
  constructor() { super('Gemini speech credits are depleted') }
}

export const pcmToWav = (pcm: Buffer, sampleRate = 24000, channels = 1): Buffer => {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  const blockAlign = channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const convertSpeech = (audio: Buffer, input: 's16le' | 'mp3', format: 'wav' | 'ogg', sampleRate = 24000, channels = 1): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const invocation = executorInvocation(
      'ffmpeg',
      [...(input === 's16le' ? ['-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels)] : ['-f', 'mp3']),
        '-i', '-', ...(format === 'ogg' ? ['-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg'] : ['-ar', '24000', '-ac', '1', '-f', 's16le']), '-'],
    )
    const child = spawn(invocation.command, invocation.args,
      { env: executorEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })

    const output: Buffer[] = []
    let error = ''

    let outputBytes = 0
    child.stdout.on('data', (chunk) => { outputBytes += chunk.length; if(outputBytes > 16 * 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Encoded speech exceeds limit')) } else output.push(chunk) })
    child.stderr.on('data', (chunk) => {
      error = (error + chunk.toString()).slice(-2048)
    })
    child.stdin.on('error', reject)

    child.on('error', reject)

    child.on('close', (code) => {
      if (code === 0 && output.length > 0) {
        resolve(format === 'wav' ? pcmToWav(Buffer.concat(output)) : Buffer.concat(output))
      } else {
        reject(new Error(`Voice encoding failed (${code}): ${error}`))
      }
    })

    child.stdin.end(audio)
  })
}

export const encodeOggOpus = (pcm: Buffer, sampleRate = 24000, channels = 1) => convertSpeech(pcm, 's16le', 'ogg', sampleRate, channels)

export const transcribeAudio = async (
  audioBytes: Buffer,
  mimeType: string,
  options: AudioOptions = {},
): Promise<string> => {
  const geminiKey = (options.geminiApiKey ?? process.env.GEMINI_API_KEY)?.trim()
  if (geminiKey) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent'
    const payload = await readRequest(
      'Gemini transcription',
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: 'Transcribe this audio faithfully. Return only the transcript, preserving its language.',
                },
                { inlineData: { mimeType: mimeType || 'audio/ogg', data: audioBytes.toString('base64') } },
              ],
            },
          ],
        }),
      },
      (response) => response.json(),
    )
    const transcript = payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!transcript) throw new Error('Gemini returned an empty transcript')
    return transcript
  }

  const openaiKey = options.openaiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (openaiKey) {
    const form = new FormData()
    form.set('model', 'whisper-1')
    form.set('response_format', 'text')
    form.set('file', new Blob([new Uint8Array(audioBytes)], { type: mimeType || 'audio/ogg' }), 'audio.ogg')

    const transcript = await readRequest(
      'OpenAI transcription',
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${openaiKey}` },
        body: form,
      },
      (response) => response.text(),
    )
    if (!transcript.trim()) throw new Error('OpenAI returned an empty transcript')
    return transcript.trim()
  }

  throw new Error('No audio transcription API key configured (set GEMINI_API_KEY or OPENAI_API_KEY)')
}

export const synthesizeSpeech = async (
  text: string,
  options: AudioOptions & { format?: 'wav' | 'ogg' } = {},
): Promise<{ buffer: Buffer; mimeType: string }> => {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Cannot synthesize speech for empty text')

  if ((options.speechProvider ?? process.env.EZ_SPEECH_PROVIDER) === 'openrouter') {
    const key = (options.openrouterApiKey ?? process.env.OPENROUTER_API_KEY)?.trim()
    if (!key) throw new Error('OpenRouter speech is not configured')
    const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST', signal: options.signal ?? AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: options.speechModel ?? process.env.EZ_SPEECH_MODEL ?? 'fish-audio/s2.1-pro-free:free',
        input: trimmed, response_format: 'mp3', ...(options.voice ? { voice: options.voice } : {}) })
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenRouter speech synthesis error ${response.status}`) }
    const chunks: Buffer[] = []; let size = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('OpenRouter returned no audio')
    try {
      for (;;) { const {done,value} = await reader.read(); if(done) break
        size += value.length; if(size > 16 * 1024 * 1024) throw new Error('Speech audio exceeds limit')
        chunks.push(Buffer.from(value)) }
    } finally { await reader.cancel() }
    if (!size) throw new Error('OpenRouter returned no audio')
    const buffer = await convertSpeech(Buffer.concat(chunks), 'mp3', options.format ?? 'ogg')
    return { buffer, mimeType: options.format === 'wav' ? 'audio/wav' : 'audio/ogg' }
  }

  const geminiKey = (options.geminiApiKey ?? process.env.GEMINI_API_KEY)?.trim()
  if (geminiKey) {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent'
    const voiceName = options.voice || 'Kore'
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
      signal: options.signal ?? AbortSignal.timeout(60_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: trimmed }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          responseFormat: { audio: { mimeType: 'AUDIO_L16', sampleRate: 24000 } },
          speechConfig: { voiceConfig: { voice: voiceName } },
        },
      }),
    })

    if (!response.ok) {
      if (response.status === 402) throw new SpeechCreditsDepletedError()
      throw new Error(`Gemini speech synthesis error ${response.status}`)
    }

    const payload = (await response.json()) as any
    const candidate = payload?.candidates?.[0]
    const inline = candidate?.content?.parts?.find(
      (part: { inlineData?: { data?: string; mimeType?: string } }) =>
        part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data,
    )?.inlineData
    if (!inline?.data)
      throw new Error(`Gemini returned no audio data (${candidate?.finishReason || 'no candidate'})`)

    const rawPcm = Buffer.from(inline.data, 'base64')
    if (!/^audio\/l16(?:;|$)/i.test(inline.mimeType) || !rawPcm.length || rawPcm.length % 2)
      throw new Error('Gemini returned an unsupported speech format')
    if (options.format === 'wav') return { buffer: pcmToWav(rawPcm), mimeType: 'audio/wav' }
    const encoded = await encodeOggOpus(rawPcm, 24000, 1)
    return {
      buffer: encoded,
      mimeType: 'audio/ogg',
    }
  }

  throw new Error('No speech synthesis API key configured (set GEMINI_API_KEY)')
}
