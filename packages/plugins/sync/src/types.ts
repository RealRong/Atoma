import type { SyncEvent, SyncMode, SyncPhase, SyncStatus } from 'atoma-types/sync'

export type SyncResourceConfig = Readonly<{
    resource: string
    storeName?: string
    collectionName?: string
    schema?: Record<string, unknown>
}>

export type SyncPluginOptions = Readonly<{
    resources: ReadonlyArray<string | SyncResourceConfig>
    mode?: SyncMode

    live?: boolean
    waitForLeadership?: boolean
    retryTimeMs?: number

    pull?: Readonly<{
        batchSize?: number
    }>
    push?: Readonly<{
        batchSize?: number
    }>
    stream?: Readonly<{
        enabled?: boolean
        pollIntervalMs?: number
        reconnectDelayMs?: number
    }>

    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}>

export type SyncExtension = Readonly<{
    sync: {
        start: (mode?: SyncMode) => void
        stop: () => void
        dispose: () => void
        status: () => SyncStatus
        pull: () => Promise<void>
        push: () => Promise<void>
        devtools: { snapshot: () => any; subscribe: (fn: (e: any) => void) => () => void }
    }
}>
