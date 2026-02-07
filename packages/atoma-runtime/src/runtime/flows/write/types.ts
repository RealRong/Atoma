import type { Entity, OperationContext, WriteIntent } from 'atoma-types/core'
import type { EntityId, WriteOp } from 'atoma-types/protocol'
import type { CoreRuntime, StoreHandle } from 'atoma-types/runtime'

export type OptimisticState<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    optimisticState: Map<EntityId, T>
    changedIds: Set<EntityId>
}>

export type PersistPlan<T extends Entity> = ReadonlyArray<{
    op: WriteOp
    intents: Array<WriteIntent<T>>
}>

export type ExecuteWriteRequest<T extends Entity> = Readonly<{
    runtime: CoreRuntime
    handle: StoreHandle<T>
    opContext: OperationContext
    writeStrategy?: string
    intents: Array<WriteIntent<T>>
}>
