import type { ChangeBatch, Cursor } from '../protocol'
import type { SyncEvent, SyncPhase } from './events'
import type { OutboxStore } from './outbox'
import type { CursorStore, SyncApplier, SyncSubscribeTransport, SyncTransport } from './transport'

export type SyncBackoffConfig = {
    baseDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
}

export type SyncRetryConfig = {
    maxAttempts?: number
}

export type SyncMode = 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'

export type SyncResolvedLaneConfig = {
    retry: SyncRetryConfig
    backoff: SyncBackoffConfig
}

export type SyncRuntimeConfig = {
    transport: SyncTransport
    subscribeTransport?: SyncSubscribeTransport
    applier: SyncApplier
    outbox: OutboxStore
    cursor: CursorStore

    push: {
        enabled: boolean
        maxItems: number
        returning: boolean
        retry: SyncRetryConfig
        backoff: SyncBackoffConfig
    }

    pull: {
        enabled: boolean
        limit: number
        debounceMs: number
        resources?: string[]
        initialCursor?: Cursor
        periodic: {
            intervalMs: number
            retry: SyncRetryConfig
            backoff: SyncBackoffConfig
        }
    }

    subscribe: {
        enabled: boolean
        reconnectDelayMs: number
        retry: SyncRetryConfig
        backoff: SyncBackoffConfig
    }

    lock: {
        key: string
        ttlMs?: number
        renewIntervalMs?: number
        backoff: SyncBackoffConfig
    }
    now?: () => number
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}

export interface SyncClient {
    start: () => void
    stop: () => void
    dispose: () => void
    push: () => Promise<void>
    pull: () => Promise<ChangeBatch | undefined>
}
