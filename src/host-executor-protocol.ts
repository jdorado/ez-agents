// Telegram batches, registered plugin events and locally created runs cross this transport.
export const isHostRunId = (id: string): boolean => /^(?:r_[a-zA-Z0-9_]+|tg_\d+|event_[a-f0-9]{64})$/.test(id)
