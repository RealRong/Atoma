import type { ResourceToken } from '../protocol'
import type { SyncOutboxStats } from './outbox'

export type SyncPhase = 'push' | 'pull' | 'notify' | 'lifecycle' | 'outbox'

export type SyncEvent =
    | { type: 'lifecycle:starting' }
    | { type: 'lifecycle:started' }
    | { type: 'lifecycle:stopped' }
    | { type: 'lifecycle:lock_failed'; error: Error }
    | { type: 'lifecycle:lock_lost'; error: Error }
    | { type: 'outbox:queue'; stats: SyncOutboxStats }
    | { type: 'outbox:queue_full'; stats: SyncOutboxStats; maxQueueSize: number }
    | { type: 'outbox:enqueue_failed'; resource: ResourceToken; count: number; error: Error }
    | { type: 'push:start' }
    | { type: 'push:idle' }
    | { type: 'push:backoff'; attempt: number; delayMs: number }
    | { type: 'pull:scheduled'; cause: 'manual' | 'periodic' | 'notify' }
    | { type: 'pull:start' }
    | { type: 'pull:idle' }
    | { type: 'pull:backoff'; attempt: number; delayMs: number }
    | { type: 'notify:connected' }
    | { type: 'notify:message'; resources?: ResourceToken[] }
    | { type: 'notify:backoff'; attempt: number; delayMs: number }
    | { type: 'notify:stopped' }
