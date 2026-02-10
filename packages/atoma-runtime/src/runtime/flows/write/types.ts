import type { Entity, OperationContext, WriteIntent } from 'atoma-types/core'
import type { EntityId, WriteOp } from 'atoma-types/protocol'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'

export type OptimisticState<T extends Entity> = Readonly<{
    beforeState: Map<EntityId, T>
    afterState: Map<EntityId, T>
}>

export type PersistPlanEntry<T extends Entity> = Readonly<{
    op: WriteOp
    intents: Array<WriteIntent<T>>
}>

export type PersistPlan<T extends Entity> = ReadonlyArray<PersistPlanEntry<T>>

export type ExecuteWriteRequest<T extends Entity> = Readonly<{
    runtime: Runtime
    handle: StoreHandle<T>
    opContext: OperationContext
    writeStrategy?: string
    intents: Array<WriteIntent<T>>
}>
