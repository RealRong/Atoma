import type { CoreStore } from '../createStore'
import type { Entity, RelationConfig, StoreHandle, StoreKey, StoreOperationOptions } from '../types'
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

type WriteOptionsMapper = (options: StoreOperationOptions | undefined) => StoreOperationOptions | undefined

export type StoreViewConfig = {
    mapWriteOptions?: WriteOptionsMapper
    includeServerAssignedCreate?: boolean
}

function applyRelations<T extends Entity>(handle: StoreHandle<T>, factory?: () => any) {
    if (!factory) return
    let cache: any | undefined
    const getter = () => {
        if (!cache) cache = factory()
        return cache
    }
    handle.relations = getter as any
}

export function createStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>,
    config?: StoreViewConfig
): CoreStore<T, Relations> {
    const name = String(handle.storeName || 'store')
    const mapWriteOptions: WriteOptionsMapper = config?.mapWriteOptions ?? ((o) => o)
    const includeServerAssignedCreate = config?.includeServerAssignedCreate !== false

    const addOneBase = createAddOne<T>(handle)
    const addManyBase = createAddMany<T>(handle)
    const updateOneBase = createUpdateOne<T>(handle)
    const updateManyBase = createUpdateMany<T>(handle)
    const deleteOneBase = createDeleteOne<T>(handle)
    const deleteManyBase = createDeleteMany<T>(handle)
    const upsertOneBase = createUpsertOne<T>(handle)
    const upsertManyBase = createUpsertMany<T>(handle)

    const createServerAssignedOneBase = includeServerAssignedCreate ? createCreateServerAssignedOne<T>(handle) : null
    const createServerAssignedManyBase = includeServerAssignedCreate ? createCreateServerAssignedMany<T>(handle) : null

    const getAll = createGetAll<T>(handle)
    const getMany = createGetMany<T>(handle)
    const { getOne, fetchOne } = createBatchGet(handle)
    const fetchAll = createFetchAll<T>(handle)
    const findMany = createFindMany<T>(handle)

    const store: any = {
        addOne: (item: Partial<T>, options?: StoreOperationOptions) => addOneBase(item, mapWriteOptions(options)),
        addMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => addManyBase(items, mapWriteOptions(options)),
        updateOne: (id: StoreKey, recipe: any, options?: StoreOperationOptions) => updateOneBase(id, recipe, mapWriteOptions(options)),
        updateMany: (items: any, options?: StoreOperationOptions) => updateManyBase(items, mapWriteOptions(options)),
        deleteOne: (id: any, options?: StoreOperationOptions) => deleteOneBase(id, mapWriteOptions(options)),
        deleteMany: (items: any, options?: StoreOperationOptions) => deleteManyBase(items, mapWriteOptions(options)),
        upsertOne: (item: any, options?: any) => upsertOneBase(item, mapWriteOptions(options)),
        upsertMany: (items: any, options?: StoreOperationOptions) => upsertManyBase(items, mapWriteOptions(options)),

        ...(includeServerAssignedCreate ? {
            createServerAssignedOne: (item: Partial<T>, options?: StoreOperationOptions) => (createServerAssignedOneBase as any)(item, mapWriteOptions(options)),
            createServerAssignedMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => (createServerAssignedManyBase as any)(items, mapWriteOptions(options))
        } : {}),

        getAll,
        getMany,
        getOne,
        fetchOne,
        fetchAll,
        findMany
    } satisfies Partial<CoreStore<T, Relations>>

    store.name = name

    store.peek = (id: StoreKey) => {
        return handle.jotaiStore.get(handle.atom).get(id)
    }

    store.peekAll = () => {
        return Array.from(handle.jotaiStore.get(handle.atom).values())
    }

    store.reset = () => {
        const before = handle.jotaiStore.get(handle.atom)
        if (!before.size) return
        const after = new Map<StoreKey, T>()
        handle.jotaiStore.set(handle.atom, after)
        handle.indexes?.applyMapDiff(before, after)
    }

    store.withRelations = <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => {
        applyRelations(handle, factory)
        return store as unknown as CoreStore<T, NewRelations>
    }

    attachStoreHandle(store as any, handle)
    return store as CoreStore<T, Relations>
}
