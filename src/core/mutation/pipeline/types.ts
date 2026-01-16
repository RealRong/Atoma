import type { Patch } from 'immer'
import type { PrimitiveAtom } from 'jotai/vanilla'
import type { EntityId, Operation } from '#protocol'
import type { Entity, OperationContext, PersistWriteback, StoreDispatchEvent, StoreHandle } from '../../types'

export type PersistMode = 'direct' | 'outbox' | 'custom'
export type PersistStatus = 'confirmed' | 'enqueued'

export type PersistResult<T extends Entity> = Readonly<{
    mode: PersistMode
    status: PersistStatus
    created?: T[]
    writeback?: PersistWriteback<T>
}>

export type TranslatedWriteOp = Readonly<{
    op: Operation
    action: 'create' | 'update' | 'upsert' | 'delete'
    entityId?: EntityId
    intent?: 'created'
    requireCreatedData?: boolean
}>

export type MutationProgramKind = 'noop' | 'hydrate' | 'writes' | 'patches' | 'serverCreate'

export type LocalMutationPlan<T extends Entity> = Readonly<{
    baseState: Map<EntityId, T>
    optimisticState: Map<EntityId, T>
    writeEvents: Array<StoreDispatchEvent<T>>
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
    writeOps: TranslatedWriteOp[]
    patches: Patch[]
    inversePatches: Patch[]
}>

export type MutationProgram<T extends Entity> =
    | (MutationProgramBase<T> & { kind: 'noop' | 'hydrate'; writeOps: [] })
    | (MutationProgramBase<T> & { kind: 'writes' })
    | (MutationProgramBase<T> & { kind: 'patches' })
    | (MutationProgramBase<T> & { kind: 'serverCreate' })
