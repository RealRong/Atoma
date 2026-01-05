import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle, StoreKey, StoreOperationOptions } from '../types'
import {
    createAddMany
} from './ops/addMany'
import { createAddOne } from './ops/addOne'
import { createBatchGet } from './ops/batchGet'
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
import { attachStoreHandle } from '../storeHandleRegistry'

export type SyncStore<T extends Entity, Relations = {}> =
    Omit<CoreStore<T, Relations>, 'createServerAssignedOne' | 'createServerAssignedMany'>

function withOutboxOptions<TOptions extends StoreOperationOptions | undefined>(options: TOptions): TOptions {
    const anyOptions = (options && typeof options === 'object' && !Array.isArray(options)) ? (options as any) : {}
    const base = (anyOptions.__atoma && typeof anyOptions.__atoma === 'object' && !Array.isArray(anyOptions.__atoma))
        ? anyOptions.__atoma
        : {}

    const requestedPersist = base.persist
    if (requestedPersist === 'direct') {
        throw new Error('[Atoma] Sync.Store: 不允许 direct persist（请使用 Store(...)）')
    }

    const requestedImplicit = base.allowImplicitFetchForWrite
    if (requestedImplicit === true) {
        throw new Error('[Atoma] Sync.Store: 不允许写入时隐式补读（enqueue 阶段不触网），请先 fetch 再写入')
    }

    return {
        ...anyOptions,
        __atoma: {
            ...base,
            persist: 'outbox',
            allowImplicitFetchForWrite: false
        }
    } as TOptions
}

export function createSyncStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>
): SyncStore<T, Relations> {
    const name = String(handle.storeName || 'store')

    const addOneBase = createAddOne<T>(handle)
    const addManyBase = createAddMany<T>(handle)
    const updateOneBase = createUpdateOne<T>(handle)
    const updateManyBase = createUpdateMany<T>(handle)
    const deleteOneBase = createDeleteOne<T>(handle)
    const deleteManyBase = createDeleteMany<T>(handle)
    const upsertOneBase = createUpsertOne<T>(handle)
    const upsertManyBase = createUpsertMany<T>(handle)

    const getAll = createGetAll<T>(handle)
    const getMany = createGetMany<T>(handle)
    const { getOne, fetchOne } = createBatchGet(handle)
    const fetchAll = createFetchAll<T>(handle)
    const findMany = createFindMany<T>(handle)

    const store: any = {
        addOne: (item: Partial<T>, options?: StoreOperationOptions) => addOneBase(item, withOutboxOptions(options)),
        addMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => addManyBase(items, withOutboxOptions(options)),
        updateOne: (id: StoreKey, recipe: any, options?: StoreOperationOptions) => updateOneBase(id, recipe, withOutboxOptions(options)),
        updateMany: (items: any, options?: StoreOperationOptions) => updateManyBase(items, withOutboxOptions(options)),
        deleteOne: (id: any, options?: StoreOperationOptions) => deleteOneBase(id, withOutboxOptions(options)),
        deleteMany: (items: any, options?: StoreOperationOptions) => deleteManyBase(items, withOutboxOptions(options)),
        upsertOne: (item: any, options?: StoreOperationOptions) => upsertOneBase(item, withOutboxOptions(options)),
        upsertMany: (items: any, options?: StoreOperationOptions) => upsertManyBase(items, withOutboxOptions(options)),

        getAll,
        getMany,
        getOne,
        fetchOne,
        fetchAll,
        findMany
    } satisfies Partial<SyncStore<T, Relations>>

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
    return store as SyncStore<T, Relations>
}
