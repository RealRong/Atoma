import type { SyncCheckpoint, SyncDocument } from 'atoma-types/sync'
import type { SyncStream } from 'atoma-types/client/sync'
import type { RxCollection, RxDatabase, RxJsonSchema } from 'rxdb'
import type { RxReplicationState } from 'rxdb/plugins/replication'

export type SyncDoc = SyncDocument & Readonly<{
    atomaSync?: Readonly<{
        resource: string
        source?: 'local' | 'remote'
        idempotencyKey?: string
        changedAtMs?: number
        clientId?: string
    }>
}>

export type SyncResourceRuntime = Readonly<{
    resource: string
    storeName: string
    collectionName: string
    schema: RxJsonSchema<SyncDoc>
}>

export type DatabaseCollections = Record<string, RxCollection<SyncDoc>>

export type ReadyRuntime = Readonly<{
    database: RxDatabase<DatabaseCollections>
    resources: ReadonlyArray<SyncResourceRuntime>
    resourceByStoreName: ReadonlyMap<string, SyncResourceRuntime>
    collectionByResource: ReadonlyMap<string, RxCollection<SyncDoc>>
}>

export type StreamHandle = SyncStream

export type ResourceReplication = Readonly<{
    resource: SyncResourceRuntime
    replication: RxReplicationState<SyncDoc, SyncCheckpoint>
    pullEnabled: boolean
    pushEnabled: boolean
    stream: StreamHandle | null
    subscriptions: Array<{ unsubscribe: () => void }>
}>

export type ResourceStateMap = Map<string, ResourceReplication>
