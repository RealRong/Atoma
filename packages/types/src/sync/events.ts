import type { ResourceToken } from '../protocol'

export type SyncPhase = 'lifecycle' | 'pull' | 'push' | 'stream' | 'bridge'

export type SyncEvent =
    | { type: 'sync.lifecycle.started' }
    | { type: 'sync.lifecycle.stopped' }
    | { type: 'sync.pull.batch'; resource: ResourceToken; size: number; cursor: number }
    | { type: 'sync.push.batch'; resource: ResourceToken; size: number }
    | { type: 'sync.stream.notify'; resource?: ResourceToken; cursor?: number }
    | { type: 'sync.conflict.detected'; resource: ResourceToken; count: number }
    | { type: 'sync.bridge.localWrite'; resource: ResourceToken; count: number }
    | { type: 'sync.bridge.remoteWriteback'; resource: ResourceToken; upserts: number; removes: number }
    | { type: 'sync.error'; phase: SyncPhase; message: string }
