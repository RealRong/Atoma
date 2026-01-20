import { SyncEngine } from './engine/SyncEngine'
import { subscribeNotifySse } from './lanes/NotifyLane'
import type { SyncClient, SyncCreateConfig } from './types'

export const Sync: {
    create: (config: SyncCreateConfig) => SyncClient
    subscribeNotifySse: typeof subscribeNotifySse
} = {
    create: (config: SyncCreateConfig) => new SyncEngine(config),
    subscribeNotifySse
}

export type {
    SyncClient,
    SyncMode,
    SyncCreateConfig,
    SyncEvent,
    SyncPhase,
    SyncApplier,
    SyncSubscribe,
    SyncOutboxItem,
    OutboxStore,
    CursorStore,
    SyncWriteAck,
    SyncWriteReject,
    SyncTransport,
    SyncOutboxEvents
} from './types'
