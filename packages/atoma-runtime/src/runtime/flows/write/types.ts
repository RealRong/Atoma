import type { Patch } from 'immer'
import type { Entity, OperationContext, ExecutionRoute } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, WriteEntry, StoreHandle } from 'atoma-types/runtime'

export type WritePatchPayload = Readonly<{
    patches: Patch[]
    inversePatches: Patch[]
}> | null

export type OptimisticState<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ReadonlySet<EntityId>
    patches: Patch[]
    inversePatches: Patch[]
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
    rawPatchPayload?: WritePatchPayload
}>

export type WriteCommitResult<T extends Entity> = Readonly<{
    patchPayload: WritePatchPayload
    output?: T
}>
