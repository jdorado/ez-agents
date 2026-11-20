export function workspaceLease(home: string, owner?: {kind: 'native' | 'plugin'; runId?: string; container?: string}): Promise<(() => Promise<void>) | undefined>;
export function recoverNativeLease(home: string): Promise<void>;
export function invokeLease(home: string, container?: string): Promise<() => Promise<void>>;
