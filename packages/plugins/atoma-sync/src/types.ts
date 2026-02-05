import type { SyncBackoffConfig, SyncEvent, SyncMode, SyncPhase, SyncRetryConfig } from 'atoma-types/sync'

export type SyncPluginOptions = Readonly<{
    mode?: SyncMode
    resources?: string[]

    pull?: Readonly<{ intervalMs?: number }>
    push?: Readonly<{ maxItems?: number }>
    subscribe?: boolean | Readonly<{ reconnectDelayMs?: number }>

    policy?: Readonly<{
        retry?: SyncRetryConfig
        backoff?: SyncBackoffConfig
    }>

    now?: () => number
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
    /** Optional client namespace override for outbox keys. */
    clientKey?: string
}>

export type SyncExtension = Readonly<{
    sync: {
        start: (mode?: SyncMode) => void
        stop: () => void
        dispose: () => void
        status: () => { started: boolean; configured: boolean }
        pull: () => Promise<void>
        push: () => Promise<void>
        devtools: { snapshot: () => any; subscribe: (fn: (e: any) => void) => () => void }
    }
}>
