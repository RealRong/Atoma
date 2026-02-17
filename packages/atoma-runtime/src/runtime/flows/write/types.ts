import type { Entity, OperationContext, ExecutionRoute, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, WriteEntry, StoreHandle } from 'atoma-types/runtime'

export type OptimisticState<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ReadonlySet<EntityId>
    changes: ReadonlyArray<StoreChange<T>>
}>

export type WritePlanEntry<T extends Entity> = Readonly<{
    entry: WriteEntry
    optimistic: Readonly<{
        entityId?: EntityId
        value?: T
    }>
}>

export type WritePlan<T extends Entity> = ReadonlyArray<WritePlanEntry<T>>

export type WriteCommitRequest<T extends Entity> = Readonly<{
    runtime: Runtime
    handle: StoreHandle<T>
    opContext: OperationContext
    route?: ExecutionRoute
    signal?: AbortSignal
    plan: WritePlan<T>
}>

export type WriteCommitResult<T extends Entity> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    output?: T
}>
