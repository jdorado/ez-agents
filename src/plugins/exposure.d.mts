export function exposure(value: unknown): Record<string, boolean>
export function commandExposure(manifest: unknown): Record<string, Record<string, boolean>>
export function taskCommandAllowed(command: unknown, capability: { access?: 'read' | 'write'; output?: 'file' }): boolean
