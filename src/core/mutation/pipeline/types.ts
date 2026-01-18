/**
 * Mutation Pipeline: Types
 * Purpose: Shared types for program planning, persistence, write intents, and segments.
 * Call chain: Used across Scheduler/LocalPlan/MutationProgram/MutationFlow/Persist/WriteOps.
 */
import type { Patch } from 'immer'
import type { PrimitiveAtom } from 'jotai/vanilla'
import type { EntityId, Operation, WriteAction, WriteItem, WriteOptions } from '#protocol'
import type { Entity, OperationContext, PersistWriteback, StoreDispatchEvent, StoreHandle } from '../../types'

export type PersistMode = 'direct' | 'outbox'
export type PersistStatus = 'confirmed' | 'enqueued'

export type PersistResult<T extends Entity> = Readonly<{
    mode: PersistMode
    status: PersistStatus
    created?: T[]
    writeback?: PersistWriteback<T>
}>

export type WriteIntent = Readonly<{
    action: WriteAction
    item: WriteItem
    options?: WriteOptions
    entityId?: EntityId
    intent?: 'created'
    requireCreatedData?: boolean
}>

export type TranslatedWriteOp = Readonly<{
    op: Operation
    action: 'create' | 'update' | 'upsert' | 'delete'
    entityId?: EntityId
    intent?: 'created'
    requireCreatedData?: boolean
}>

export type MutationProgramKind = 'noop' | 'hydrate' | 'writes' | 'patches' | 'serverAssignedCreate'

export type LocalMutationPlan<T extends Entity> = Readonly<{
    baseState: Map<EntityId, T>
    optimisticState: Map<EntityId, T>
    writeEvents: Array<StoreDispatchEvent<T>>
    writeIntents: WriteIntent[]
    hasCreate: boolean
    hasPatches: boolean
    changedIds: Set<EntityId>
    patches: Patch[]
    inversePatches: Patch[]
}>

export type MutationCommitInfo = Readonly<{
    storeName: string
    opContext: OperationContext
    patches: Patch[]
    inversePatches: Patch[]
}>

export type MutationSegment<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    opContext?: OperationContext
}>

type MutationProgramBase<T extends Entity> = Readonly<{
    kind: MutationProgramKind
    persistMode: 'direct' | 'outbox'
    atom: PrimitiveAtom<Map<EntityId, T>>
    baseState: Map<EntityId, T>
    optimisticState: Map<EntityId, T>
    rollbackState: Map<EntityId, T>
    changedIds: ReadonlySet<EntityId>
    writeIntents: WriteIntent[]
    writeOps: TranslatedWriteOp[]
    patches: Patch[]
    inversePatches: Patch[]
}>

export type MutationProgram<T extends Entity> =
    | (MutationProgramBase<T> & { kind: 'noop' | 'hydrate'; writeIntents: []; writeOps: [] })
    | (MutationProgramBase<T> & { kind: 'writes' })
    | (MutationProgramBase<T> & { kind: 'patches' })
    | (MutationProgramBase<T> & { kind: 'serverAssignedCreate' })
