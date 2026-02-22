import type {
    Entity,
    ActionContext,
    StoreChange,
    WriteManyResult,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, WriteEntry, WriteOutput, StoreHandle } from 'atoma-types/runtime'

export type WriteScope<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    context: ActionContext
    signal?: AbortSignal
}>

export type PreparedWrite<T extends Entity> = Readonly<{
    entry: WriteEntry
    optimistic: StoreChange<T>
    output?: T
}>

export type PreparedWrites<T extends Entity> = ReadonlyArray<PreparedWrite<T>>

export type WriteCommitRequest<T extends Entity> = Readonly<{
    runtime: Runtime
    scope: WriteScope<T>
    prepared: PreparedWrites<T>
}>

export type WriteCommitResult<T extends Entity> = Readonly<{
    status: WriteOutput['status']
    changes: ReadonlyArray<StoreChange<T>>
    results: WriteManyResult<T | void>
}>

export type IntentAction = 'create' | 'update' | 'upsert' | 'delete'
export type NonDeleteIntentAction = Exclude<IntentAction, 'delete'>

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
export type IntentCommandByAction<T extends Entity, A extends IntentAction> = IntentCommandMap<T>[A]
