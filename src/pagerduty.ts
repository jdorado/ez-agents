export type PagerDutyStocksMonitorOptions = {
  routingKey: string
  healthUrl: string
  pollMs: number
  failureThreshold: number
  fetcher?: typeof fetch
  onError?: (error: Error) => void
}

const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue'
const STOCKS_DEDUP_KEY = 'ez:stocks:critical-health'

/**
 * Monitors the deliberately narrow Stocks critical-health endpoint. It keeps
 * state in memory on purpose: PagerDuty's deduplication key is the durable
 * incident authority, while a restart should need a fresh sustained failure.
 */
export class PagerDutyStocksMonitor {
  private readonly fetcher: typeof fetch
  private consecutiveFailures = 0
  private incidentOpen = false
  private recoveryPending = true
  private checking = false
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly options: PagerDutyStocksMonitorOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  start(): void {
    if (this.timer) return
    void this.check()
    this.timer = setInterval(() => { void this.check() }, this.options.pollMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const response = await this.fetcher(this.options.healthUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(`Stocks health returned HTTP ${response.status}`)
      const health: unknown = await response.json()
      if (!health || typeof health !== 'object' || (health as { status?: unknown }).status !== 'ok')
        throw new Error('Stocks critical health is not ok')

      this.consecutiveFailures = 0
      if (this.recoveryPending) {
        try {
          await this.send('resolve')
          this.incidentOpen = false
          this.recoveryPending = false
        } catch (error) { this.report(error) }
      }
    } catch (error) {
      this.consecutiveFailures += 1
      if (!this.incidentOpen && this.consecutiveFailures >= this.options.failureThreshold) {
        try {
          this.recoveryPending = true
          await this.send('trigger')
          this.incidentOpen = true
        } catch (sendError) {
          this.report(sendError)
        }
      }
      this.report(error)
    } finally {
      this.checking = false
    }
  }

  private async send(action: 'trigger' | 'resolve'): Promise<void> {
    const response = await this.fetcher(PAGERDUTY_EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        routing_key: this.options.routingKey,
        event_action: action,
        dedup_key: STOCKS_DEDUP_KEY,
        payload: {
          summary: action === 'trigger'
            ? 'Stocks critical health is unavailable'
            : 'Stocks critical health recovered',
          source: 'ez-core',
          severity: 'critical',
          component: 'stocks',
          custom_details: { failed_checks: this.consecutiveFailures },
        },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`PagerDuty Events API returned HTTP ${response.status}`)
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error'
    this.options.onError?.(new Error(message))
  }
}
