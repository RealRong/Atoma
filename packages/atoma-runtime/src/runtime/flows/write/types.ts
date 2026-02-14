import type { Entity, OperationContext, ExecutionRoute } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, RuntimeWriteEntry, StoreHandle } from 'atoma-types/runtime'

export type OptimisticState<T extends Entity> = Readonly<{
    beforeState: Map<EntityId, T>
    afterState: Map<EntityId, T>
}>

export type WritePlanEntry<T extends Entity> = Readonly<{
    entry: RuntimeWriteEntry
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
