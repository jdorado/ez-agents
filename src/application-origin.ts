export type ApplicationOrigin = {
  bindingId: string
  scope: string
  requestId: string
  followTelegram?: boolean
  inputText?: string
  attachmentHash?: string
  context?: Record<string, unknown>
}
export const applicationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_:.\-]{1,200}$/.test(value)
export const validApplicationOrigin = (value: unknown): value is ApplicationOrigin => {
  const origin = value as ApplicationOrigin | undefined
  return !!origin && /^[a-f0-9-]{36}$/.test(origin.bindingId) && applicationId(origin.scope) && applicationId(origin.requestId) &&
    (origin.followTelegram === undefined || typeof origin.followTelegram === 'boolean') &&
    (origin.inputText === undefined || (typeof origin.inputText === 'string' && origin.inputText.length <= 16000)) &&
    (origin.attachmentHash === undefined || /^[a-f0-9]{64}$/.test(origin.attachmentHash)) &&
    (origin.context === undefined || (!!origin.context && typeof origin.context === 'object' && !Array.isArray(origin.context) && JSON.stringify(origin.context).length <= 48000))
}
