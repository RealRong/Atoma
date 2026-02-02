import type { Entity, PartialWithId, StoreOperationOptions, UpsertWriteOptions, WriteManyResult } from 'atoma-core'
import type { Draft } from 'immer'
import type { EntityId } from 'atoma-protocol'
import type { CoreRuntime, StoreHandle } from '../../types/runtimeTypes'

export function createAddOne<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        return await clientRuntime.write.addOne(handle, obj, options)
    }
}

export function createAddMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (items: Array<Partial<T>>, options?: StoreOperationOptions) => {
        return await clientRuntime.write.addMany(handle, items, options)
    }
}

export function createUpdateOne<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (id: EntityId, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => {
        return await clientRuntime.write.updateOne(handle, id, recipe, options)
    }
}

export function createUpdateMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (
        items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        return await clientRuntime.write.updateMany(handle, items, options)
    }
}

export function createUpsertOne<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (
        item: PartialWithId<T>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ): Promise<T> => {
        return await clientRuntime.write.upsertOne(handle, item, options)
    }
}

export function createUpsertMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (
        items: Array<PartialWithId<T>>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ): Promise<WriteManyResult<T>> => {
        return await clientRuntime.write.upsertMany(handle, items, options)
    }
}

export function createDeleteOne<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (id: EntityId, options?: StoreOperationOptions) => {
        return await clientRuntime.write.deleteOne(handle, id, options)
    }
}

export function createDeleteMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        return await clientRuntime.write.deleteMany(handle, ids, options)
    }
}
