import { SyncEngine } from '#sync/engine/SyncEngine'
import { createOpsTransport } from '#sync/transport/opsTransport'
import { subscribeNotifySse } from '#sync/transport/sseNotify'
import type { SyncClient, SyncRuntimeConfig } from '#sync/types'
export { wantsPush, wantsSubscribe } from './mode'

export const createSyncEngine = (config: SyncRuntimeConfig): SyncClient => new SyncEngine(config)

export const Sync: {
    create: (config: SyncRuntimeConfig) => SyncClient
    subscribeNotifySse: typeof subscribeNotifySse
    createOpsTransport: typeof createOpsTransport
} = {
    create: createSyncEngine,
    subscribeNotifySse,
    createOpsTransport
}

export { createOpsTransport } from './transport/opsTransport'
export { subscribeNotifySse } from './transport/sseNotify'

export { withSync, syncPlugin } from './withSync'
export type { WithSyncOptions, WithSyncExtension } from './withSync'

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
    SyncOutboxStats,
    OutboxWrite,
    OutboxStore,
    CursorStore,
    SyncWriteAck,
    SyncWriteReject,
    SyncTransport,
    SyncPushOutcome,
    SyncOutboxEvents
} from './types'

export type {
    SyncStores,
    SyncStoresConfig,
} from './store'

export { createStores } from './store'
