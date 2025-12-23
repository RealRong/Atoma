import type { Entity, StoreKey } from '../../../core/types'
import type { Change } from '#protocol'
import type { SyncWriteAck, SyncWriteReject } from '../../../sync/types'

export type StateWriteInstruction<T extends Entity = Entity> =
    | { kind: 'upsert'; items: T[] }
    | { kind: 'delete'; keys: StoreKey[] }
    | { kind: 'updateVersion'; key: StoreKey; version: number }

export type StateWriteInput<T extends Entity = Entity> =
    | { source: 'syncChanges'; changes: Change[] }
    | { source: 'syncAck'; ack: SyncWriteAck }
    | { source: 'syncReject'; reject: SyncWriteReject; conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual' }
