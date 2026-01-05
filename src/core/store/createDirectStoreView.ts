import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle, StoreKey, StoreOperationOptions } from '../types'
import { attachStoreHandle } from '../storeHandleRegistry'
import { createAddMany } from './ops/addMany'
import { createAddOne } from './ops/addOne'
import { createBatchGet } from './ops/batchGet'
import { createCreateServerAssignedMany } from './ops/createServerAssignedMany'
import { createCreateServerAssignedOne } from './ops/createServerAssignedOne'
import { createDeleteMany } from './ops/deleteMany'
import { createDeleteOne } from './ops/deleteOne'
import { createFetchAll } from './ops/fetchAll'
import { createFindMany } from './ops/findMany'
import { createGetAll } from './ops/getAll'
import { createGetMany } from './ops/getMany'
import { createUpdateMany } from './ops/updateMany'
import { createUpdateOne } from './ops/updateOne'
import { createUpsertMany } from './ops/upsertMany'
import { createUpsertOne } from './ops/upsertOne'

function withDirectOptions<TOptions extends StoreOperationOptions | undefined>(options: TOptions): TOptions {
    const anyOptions = (options && typeof options === 'object' && !Array.isArray(options)) ? (options as any) : {}
    const base = (anyOptions.__atoma && typeof anyOptions.__atoma === 'object' && !Array.isArray(anyOptions.__atoma))
        ? anyOptions.__atoma
        : {}

    const requestedPersist = base.persist
    if (requestedPersist === 'outbox') {
        throw new Error('[Atoma] Store: 不允许 outbox persist（请使用 Sync.Store(...)）')
    }

    return options
}

export function createDirectStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>
): CoreStore<T, Relations> {
    const name = String(handle.storeName || 'store')

    const addOne = createAddOne<T>(handle)
    const addMany = createAddMany<T>(handle)
    const createServerAssignedOne = createCreateServerAssignedOne<T>(handle)
    const createServerAssignedMany = createCreateServerAssignedMany<T>(handle)
    const updateOne = createUpdateOne<T>(handle)
    const updateMany = createUpdateMany<T>(handle)
    const deleteOne = createDeleteOne<T>(handle)
    const deleteMany = createDeleteMany<T>(handle)
    const upsertOne = createUpsertOne<T>(handle)
    const upsertMany = createUpsertMany<T>(handle)

    const getAll = createGetAll<T>(handle)
    const getMany = createGetMany<T>(handle)
    const { getOne, fetchOne } = createBatchGet(handle)
    const fetchAll = createFetchAll<T>(handle)
    const findMany = createFindMany<T>(handle)

    const store: any = {
        addOne: (item: Partial<T>, options?: StoreOperationOptions) => addOne(item, withDirectOptions(options)),
        addMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => addMany(items, withDirectOptions(options)),
        createServerAssignedOne: (item: Partial<T>, options?: StoreOperationOptions) => createServerAssignedOne(item, withDirectOptions(options)),
        createServerAssignedMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => createServerAssignedMany(items, withDirectOptions(options)),
        updateOne: (id: StoreKey, recipe: any, options?: StoreOperationOptions) => updateOne(id, recipe, withDirectOptions(options)),
        updateMany: (items: any, options?: StoreOperationOptions) => updateMany(items, withDirectOptions(options)),
        deleteOne: (id: any, options?: StoreOperationOptions) => deleteOne(id, withDirectOptions(options)),
        deleteMany: (items: any, options?: StoreOperationOptions) => deleteMany(items, withDirectOptions(options)),
        upsertOne: (item: any, options?: any) => upsertOne(item, withDirectOptions(options)),
        upsertMany: (items: any, options?: any) => upsertMany(items, withDirectOptions(options)),

        getAll,
        getMany,
        getOne,
        fetchOne,
        fetchAll,
        findMany
    } satisfies Partial<CoreStore<T, Relations>>

    store.name = name

    store.getCachedOneById = (id: StoreKey) => {
        return handle.jotaiStore.get(handle.atom).get(id)
    }

    store.getCachedAll = () => {
        return Array.from(handle.jotaiStore.get(handle.atom).values())
    }

    const applyRelations = (factory?: () => any) => {
        if (!factory) return
        let cache: any | undefined
        const getter = () => {
            if (!cache) cache = factory()
            return cache
        }
        handle.relations = getter as any
    }

    store.withRelations = (factory: any) => {
        applyRelations(factory)
        return store
    }

    attachStoreHandle(store as any, handle)
    return store as CoreStore<T, Relations>
}

