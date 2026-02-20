import type {
    Entity,
    PartialWithId,
    StoreChange,
    StoreOperationOptions,
    StoreUpdater,
    UpsertWriteOptions,
    WriteManyResult,
} from '../core'
import type { EntityId } from '../shared'
import type { StoreHandle } from './store/handle'

export type Write = Readonly<{
    create: <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions) => Promise<T>
    createMany: <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<Partial<T>>,
        options?: StoreOperationOptions
    ) => Promise<WriteManyResult<T>>
    update: <T extends Entity>(
        handle: StoreHandle<T>,
        id: EntityId,
        updater: StoreUpdater<T>,
        options?: StoreOperationOptions
    ) => Promise<T>
    updateMany: <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ) => Promise<WriteManyResult<T>>
    upsert: <T extends Entity>(
        handle: StoreHandle<T>,
        item: PartialWithId<T>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ) => Promise<T>
    upsertMany: <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<PartialWithId<T>>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ) => Promise<WriteManyResult<T>>
    delete: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions) => Promise<void>
    deleteMany: <T extends Entity>(
        handle: StoreHandle<T>,
        ids: EntityId[],
        options?: StoreOperationOptions
    ) => Promise<WriteManyResult<void>>
    apply: <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ) => Promise<void>
    revert: <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ) => Promise<void>
}>
