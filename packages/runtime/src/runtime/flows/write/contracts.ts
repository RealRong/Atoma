import type {
    Entity,
    ActionContext,
    PartialWithId,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions
} from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/shared'
import type { StoreHandle } from '@atoma-js/types/runtime'

export type WriteScope<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    context: ActionContext
    signal?: AbortSignal
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
