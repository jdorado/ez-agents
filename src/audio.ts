import { spawn } from 'node:child_process'
import { readRequest } from './read-request.js'

export type AudioOptions = {
  geminiApiKey?: string
  openaiApiKey?: string
  voice?: string
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

export const encodeOggOpus = (pcm: Buffer, sampleRate = 24000, channels = 1): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-f',
        's16le',
        '-ar',
        String(sampleRate),
        '-ac',
        String(channels),
        '-i',
        '-',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-f',
        'ogg',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const output: Buffer[] = []
    let error = ''

    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => {
      error = (error + chunk.toString()).slice(-2048)
    })
    child.stdin.on('error', reject)

    child.on('error', reject)

    child.on('close', (code) => {
      if (code === 0 && output.length > 0) {
        resolve(Buffer.concat(output))
      } else {
        reject(new Error(`Voice encoding failed (${code}): ${error}`))
      }
    })

    child.stdin.end(pcm)
  })
}

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
  options: AudioOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> => {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Cannot synthesize speech for empty text')

  const geminiKey = (options.geminiApiKey ?? process.env.GEMINI_API_KEY)?.trim()
  if (geminiKey) {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent'
    const voiceName = options.voice || 'Kore'
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: trimmed }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    })

    if (!response.ok) {
      const err = await response.text().catch(() => '')
      throw new Error(`Gemini speech synthesis error ${response.status}: ${err}`)
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
    const encoded = await encodeOggOpus(rawPcm, 24000, 1)
    return {
      buffer: encoded,
      mimeType: 'audio/ogg',
    }
  }

  throw new Error('No speech synthesis API key configured (set GEMINI_API_KEY)')
}
