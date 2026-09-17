export function workspaceLease(home: string, owner?: {kind: 'native' | 'plugin'; runId?: string}): Promise<(() => Promise<void>) | undefined>;
export function recoverNativeLease(home: string): Promise<void>;
export function invokeLease(home: string): Promise<() => Promise<void>>;
