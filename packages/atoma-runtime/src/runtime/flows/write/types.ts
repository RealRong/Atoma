import type {
    Entity,
    ActionContext,
    ExecutionRoute,
    StoreChange,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, WriteEntry, StoreHandle } from 'atoma-types/runtime'

export type WriteScope<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    context: ActionContext
    route?: ExecutionRoute
    signal?: AbortSignal
}>

export type PreparedWrite<T extends Entity> = Readonly<{
    entry: WriteEntry
    optimisticChange: StoreChange<T>
    output?: T
}>

export type WriteCommitRequest<T extends Entity> = Readonly<{
    runtime: Runtime
    scope: WriteScope<T>
    prepared: PreparedWrite<T>
}>

export type WriteCommitResult<T extends Entity> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    output?: T
}>

export type IntentAction = 'create' | 'update' | 'upsert' | 'delete'

type IntentPayload<T extends Entity> = {
    create: Readonly<{ item: Partial<T> }>
    update: Readonly<{ id: EntityId; updater: StoreUpdater<T> }>
    upsert: Readonly<{ item: PartialWithId<T> }>
    delete: Readonly<{ id: EntityId }>
}

type IntentOptions = {
    create: StoreOperationOptions
    update: StoreOperationOptions
    upsert: StoreOperationOptions & UpsertWriteOptions
    delete: StoreOperationOptions
}

type IntentCommandMap<T extends Entity> = {
    [A in IntentAction]: Readonly<{
        action: A
        options?: IntentOptions[A]
    } & IntentPayload<T>[A]>
}

export type IntentCommand<T extends Entity> = IntentCommandMap<T>[IntentAction]

type IntentInputMap<T extends Entity> = {
    [A in IntentAction]: Readonly<{
        kind: 'intent'
        scope: WriteScope<T>
    } & IntentCommandMap<T>[A]>
}

export type IntentInput<T extends Entity> = IntentInputMap<T>[IntentAction]
export type IntentInputByAction<T extends Entity, A extends IntentAction> = IntentInputMap<T>[A]
