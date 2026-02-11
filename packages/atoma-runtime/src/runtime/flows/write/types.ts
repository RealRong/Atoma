import type { Entity, OperationContext } from 'atoma-types/core'
import type { EntityId, WriteEntry } from 'atoma-types/protocol'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'

export type OptimisticState<T extends Entity> = Readonly<{
    beforeState: Map<EntityId, T>
    afterState: Map<EntityId, T>
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
    writeStrategy?: string
    plan: WritePlan<T>
}>
