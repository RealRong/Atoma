import type { Patch } from 'immer'
import type { PrimitiveAtom } from 'jotai/vanilla'
import type { ObservabilityContext } from '#observability'
import type { EntityId } from '#protocol'
import type {
    Entity,
    OperationContext,
    PatchMetadata,
    PersistWriteback,
    StoreDispatchEvent,
    StoreHandle
} from '../../types'
import type { StoreIndexes } from '../../indexes/StoreIndexes'
import type { Committer as MutationCommitter } from '../types'

export type Plan<T extends Entity> = Readonly<{
    nextState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    changedFields: Set<string>
    appliedData: any[]
    operationTypes: StoreDispatchEvent<T>['type'][]
    atom: PrimitiveAtom<Map<EntityId, T>>
}>

export interface Planner {
    plan: <T extends Entity>(
        operations: StoreDispatchEvent<T>[],
        currentState: Map<EntityId, T>
    ) => Plan<T>
}

export type PersisterPersistArgs<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    plan: Plan<T>
    metadata: PatchMetadata
    observabilityContext: ObservabilityContext
}>

export type PersisterPersistResult<T extends Entity> = { created?: T[]; writeback?: PersistWriteback<T> } | void

export interface Persister {
    persist: <T extends Entity>(args: PersisterPersistArgs<T>) => Promise<PersisterPersistResult<T>>
}

export type RecorderRecordArgs<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    storeName: string
    opContext: OperationContext
    plan: Plan<T>
}>

export interface Recorder {
    record: <T extends Entity>(args: RecorderRecordArgs<T>) => void
}

export type ExecutorRunArgs<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    plan: Plan<T>
    atom: PrimitiveAtom<Map<any, any>>
    store: any
    indexes?: StoreIndexes<T> | null
    observabilityContext: ObservabilityContext
    storeName?: string
    opContext?: OperationContext
}>

export type CommitOptimisticBeforePersistArgs<T extends Entity> = Readonly<{
    atom: PrimitiveAtom<Map<any, any>>
    store: any
    plan: Plan<T>
    originalState: Map<any, any>
    indexes?: StoreIndexes<T> | null
}>

export type CommitAfterPersistArgs<T extends Entity> = Readonly<{
    atom: PrimitiveAtom<Map<any, any>>
    store: any
    plan: Plan<T>
    createdResults?: T[]
    writeback?: PersistWriteback<T>
    indexes?: StoreIndexes<T> | null
}>

export type RollbackOptimisticArgs<T extends Entity> = Readonly<{
    atom: PrimitiveAtom<Map<any, any>>
    store: any
    plan: Plan<T>
    originalState: Map<any, any>
    indexes?: StoreIndexes<T> | null
}>

export interface ICommitter {
    commitOptimisticBeforePersist: <T extends Entity>(args: CommitOptimisticBeforePersistArgs<T>) => void
    commitAfterPersist: <T extends Entity>(args: CommitAfterPersistArgs<T>) => void
    rollbackOptimistic: <T extends Entity>(args: RollbackOptimisticArgs<T>) => void
}

export interface IExecutor {
    planner: Planner
    committer: MutationCommitter
    run: <T extends Entity>(args: ExecutorRunArgs<T>) => Promise<void>
}
