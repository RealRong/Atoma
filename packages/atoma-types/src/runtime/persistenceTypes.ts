import type * as Types from '../core'
import type { EntityId, Operation } from '../protocol'
import type { StoreHandle } from './handleTypes'

/**
 * Writeback payload for applying remote changes to memory/durable stores.
 */
export type PersistWriteback<T extends Types.Entity> = Readonly<{
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

/**
 * Persist ack (server authoritative response for a write batch).
 * - Used to override local state with server versions/data when available.
 */
export type PersistAck<T extends Types.Entity> = Readonly<{
    created?: T[]
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

export type PersistStatus = 'confirmed' | 'enqueued'

export type TranslatedWriteOp = Readonly<{
    op: Operation
    action: 'create' | 'update' | 'upsert' | 'delete'
    entityId?: EntityId
    intent?: 'created'
    requireCreatedData?: boolean
}>

export type PersistRequest<T extends Types.Entity> = Readonly<{
    storeName: Types.StoreToken
    writeStrategy?: Types.WriteStrategy
    handle: StoreHandle<T>
    writeOps: Array<TranslatedWriteOp>
    signal?: AbortSignal
    context?: Types.ObservabilityContext
}>

export type PersistResult<T extends Types.Entity> = Readonly<{
    status: PersistStatus
    ack?: PersistAck<T>
}>

export type PersistHandler = <T extends Types.Entity>(args: {
    req: PersistRequest<T>
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

export type WritePolicy = Readonly<{
    implicitFetch?: boolean
    optimistic?: boolean
}>

export type StrategyDescriptor = Readonly<{
    persist?: PersistHandler
    write?: WritePolicy
}>

export interface Persistence {
    persist: <T extends Types.Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}
