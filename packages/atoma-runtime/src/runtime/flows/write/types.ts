import type {
    Entity,
    OperationContext,
    ExecutionRoute,
    StoreChange,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions
} from 'atoma-types/core'
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

export type IntentAction = 'add' | 'update' | 'upsert' | 'delete'

type IntentPayload<T extends Entity> = {
    add: Readonly<{ item: Partial<T> }>
    update: Readonly<{ id: EntityId; updater: StoreUpdater<T> }>
    upsert: Readonly<{ item: PartialWithId<T> }>
    delete: Readonly<{ id: EntityId }>
}

type IntentOptions = {
    add: StoreOperationOptions
    update: StoreOperationOptions
    upsert: StoreOperationOptions & UpsertWriteOptions
    delete: StoreOperationOptions
}

type IntentInputMap<T extends Entity> = {
    [A in IntentAction]: Readonly<{
        kind: 'intent'
        action: A
        handle: StoreHandle<T>
        opContext: OperationContext
        options?: IntentOptions[A]
    } & IntentPayload<T>[A]>
}

export type IntentInput<T extends Entity> = IntentInputMap<T>[IntentAction]
export type IntentInputByAction<T extends Entity, A extends IntentAction> = IntentInputMap<T>[A]

export type ReplayInput<T extends Entity> = Readonly<{
    kind: 'change-replay'
    options?: StoreOperationOptions
    changes: ReadonlyArray<StoreChange<T>>
}>

export type WriteInput<T extends Entity> = IntentInput<T> | ReplayInput<T>

export type WritePlanPolicy = Readonly<{
    action?: WriteEntry['action']
    upsertMode?: 'strict' | 'loose'
    merge?: boolean
}>
