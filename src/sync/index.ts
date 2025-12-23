import { SyncEngine } from './engine/SyncEngine'
import type { SyncClient, SyncConfig } from './types'

export const Sync: { create: (config: SyncConfig) => SyncClient } = {
    create: (config: SyncConfig) => new SyncEngine(config)
}

export type {
    SyncClient,
    SyncConfig,
    SyncEvent,
    SyncPhase,
    SyncOutboxItem,
    SyncWriteAck,
    SyncWriteReject,
    SyncTransport,
    SyncOutboxEvents
} from './types'
