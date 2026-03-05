import type { ResourceToken } from '../protocol'
import type {
    SyncPullRequest,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
    SyncStreamNotify
} from '../sync'
import { createServiceToken } from './services'

export type SyncStream = Readonly<{
    start: () => void
    stop: () => void
    dispose: () => void
}>

export type SyncTransport = Readonly<{
    pull: (request: SyncPullRequest) => Promise<SyncPullResponse>
    push: (request: SyncPushRequest) => Promise<SyncPushResponse>
    subscribe?: (args: {
        resource: ResourceToken
        reconnectDelayMs: number
        pollIntervalMs: number
        onNotify: (notify: SyncStreamNotify) => void
        onError: (error: unknown) => void
    }) => SyncStream | null
}>

export const SYNC_TRANSPORT_TOKEN = createServiceToken<SyncTransport>('sync.transport')
