import type { ObservabilityContext } from 'atoma-observability'
import type { Entity, StoreToken, WriteStrategy } from 'atoma-core'
import type { EntityId, Operation } from 'atoma-protocol'
import type { StoreHandle } from './handleTypes'

/**
 * Writeback payload for applying remote changes to memory/durable stores.
 */
export type PersistWriteback<T extends Entity> = Readonly<{
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

/**
 * Persist ack (server authoritative response for a write batch).
 * - Used to override local state with server versions/data when available.
 */
export type PersistAck<T extends Entity> = Readonly<{
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

export type PersistRequest<T extends Entity> = Readonly<{
    storeName: StoreToken
    writeStrategy?: WriteStrategy
    handle: StoreHandle<T>
    writeOps: Array<TranslatedWriteOp>
    signal?: AbortSignal
    context?: ObservabilityContext
}>

export type PersistResult<T extends Entity> = Readonly<{
    status: PersistStatus
    ack?: PersistAck<T>
}>

export type PersistHandler = <T extends Entity>(args: {
    req: PersistRequest<T>
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

export type WritePolicy = Readonly<{
    implicitFetch?: boolean
}>

export type StrategyDescriptor = Readonly<{
    persist?: PersistHandler
    write?: WritePolicy
}>

export interface Persistence {
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}
