import { SyncEngine } from './engine/SyncEngine'
import { subscribeNotifySse } from './lanes/NotifyLane'
import type { SyncClient, SyncRuntimeConfig } from './types'
export { wantsPush, wantsSubscribe } from './mode'

export const createSyncEngine = (config: SyncRuntimeConfig): SyncClient => new SyncEngine(config)

export const Sync: {
    create: (config: SyncRuntimeConfig) => SyncClient
    subscribeNotifySse: typeof subscribeNotifySse
} = {
    create: createSyncEngine,
    subscribeNotifySse
}

export type {
    SyncClient,
    SyncMode,
    SyncRuntimeConfig,
    SyncEvent,
    SyncPhase,
    SyncRetryConfig,
    SyncBackoffConfig,
    SyncApplier,
    SyncSubscribe,
    SyncOutboxItem,
    OutboxReader,
    OutboxWriter,
    OutboxEvents,
    CursorStore,
    SyncWriteAck,
    SyncWriteReject,
    SyncTransport,
    SyncOutboxEvents
} from './types'

export type {
    SyncStores,
    SyncStoresConfig,
} from './store'

export { createStores } from './store'
