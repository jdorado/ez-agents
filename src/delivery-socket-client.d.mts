export type DeliverySocketRequest = { op: string; payload?: unknown }
export function deliverySocketPath(controlDir: string): string
export function callDeliverySocket(socketPath: string, op: DeliverySocketRequest, timeoutMs?: number): Promise<unknown>
export function deliverySocketAlive(socketPath: string, timeoutMs?: number): Promise<boolean>
