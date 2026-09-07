// Only for repeatable input reads/transcription. Never wrap an external action or chat send.
class ResponseError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number,
  ) {
    super(`HTTP ${status}`)
  }
}

const networkCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return
  const e = error as { code?: string; cause?: unknown; errors?: unknown[]; name?: string }
  if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code)) return e.code
  if (e.name === 'TimeoutError') return 'TIMEOUT'
  return networkCode(e.cause) || e.errors?.map(networkCode).find(Boolean)
}

export async function readRequest<T>(
  label: string,
  url: string,
  options: RequestInit,
  decode: (response: Response) => Promise<T>,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) })
      if (!response.ok) {
        const header = response.headers.get('retry-after')
        const seconds = header === null ? NaN : Number(header)
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header || '') - Date.now()
        await response.body?.cancel()
        throw new ResponseError(response.status, Number.isFinite(delay) ? Math.max(0, delay) : 0)
      }
      // Include streaming/body failures in the same retry boundary.
      return await decode(response)
    } catch (error) {
      const code = networkCode(error)
      const http = error instanceof ResponseError ? error : undefined
      const transient = http
        ? [408, 429, 500, 502, 503, 504].includes(http.status) && http.retryAfter <= 30_000
        : [
            'ECONNRESET',
            'ECONNREFUSED',
            'EAI_AGAIN',
            'ETIMEDOUT',
            'ENETUNREACH',
            'EHOSTUNREACH',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_SOCKET',
            'TIMEOUT',
          ].includes(code || '') ||
          (!code && error instanceof TypeError && error.message === 'fetch failed')
      // Do not include provider bodies, URLs or raw error messages (they can contain credentials).
      const detail =
        http?.message || code || (error instanceof SyntaxError ? 'invalid response JSON' : 'request failed')
      if (!transient || attempt === 3)
        throw new Error(`${label}: ${detail} (after ${attempt} attempt${attempt === 1 ? '' : 's'})`)
      const delay = Math.max(1000 * 2 ** (attempt - 1), http?.retryAfter || 0)
      console.warn(`${label}: ${detail}; retry ${attempt + 1}/3 in ${delay}ms`)
      await sleep(delay)
    }
  }
}

export const downloadTelegramFile = (url: string): Promise<Buffer> =>
  readRequest('Telegram attachment download', url, {}, async (response) =>
    Buffer.from(await response.arrayBuffer()),
  )
