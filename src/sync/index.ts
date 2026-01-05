import { SyncEngine } from './engine/SyncEngine'
import { subscribeNotifySse } from './lanes/NotifyLane'
import type { SyncClient, SyncConfig } from './types'

export const Sync: {
    create: (config: SyncConfig) => SyncClient
    subscribeNotifySse: typeof subscribeNotifySse
} = {
    create: (config: SyncConfig) => new SyncEngine(config),
    subscribeNotifySse
}

export type {
    SyncClient,
    SyncConfig,
    SyncEvent,
    SyncPhase,
    SyncApplier,
    SyncSubscribe,
    SyncOutboxItem,
    SyncWriteAck,
    SyncWriteReject,
    SyncTransport,
    SyncOutboxEvents
} from './types'
