import type { Draft, Patch } from 'immer'
import type {
    Entity,
    PartialWithId,
    StoreOperationOptions,
    UpsertWriteOptions,
    WriteManyResult,
} from '../core'
import type { EntityId } from '../shared'
import type { StoreHandle } from './handle'

export type Write = Readonly<{
    addOne: <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions) => Promise<T>
    addMany: <T extends Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: StoreOperationOptions) => Promise<T[]>
    updateOne: <T extends Entity>(
        handle: StoreHandle<T>,
        id: EntityId,
        recipe: (draft: Draft<T>) => void,
        options?: StoreOperationOptions
    ) => Promise<T>
    updateMany: <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ) => Promise<WriteManyResult<T>>
    upsertOne: <T extends Entity>(
        handle: StoreHandle<T>,
        item: PartialWithId<T>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ) => Promise<T>
    upsertMany: <T extends Entity>(
        handle: StoreHandle<T>,
        items: Array<PartialWithId<T>>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ) => Promise<WriteManyResult<T>>
    deleteOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions) => Promise<boolean>
    deleteMany: <T extends Entity>(
        handle: StoreHandle<T>,
        ids: EntityId[],
        options?: StoreOperationOptions
    ) => Promise<WriteManyResult<boolean>>
    patches: <T extends Entity>(
        handle: StoreHandle<T>,
        patches: Patch[],
        inversePatches: Patch[],
        options?: StoreOperationOptions
    ) => Promise<void>
}>
