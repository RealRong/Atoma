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

export type SyncStoreViewConfig = {
    /**
     * 是否允许写入时在 cache miss 的情况下进行隐式补读。
     * - intent-only（默认）：false（禁止任何隐式补读）
     * - local-first：true（允许本地 durable 补读；远端补读需由上层保证不会发生）
     */
    allowImplicitFetchForWrite?: boolean
}

function withOutboxOptions<TOptions extends StoreOperationOptions | undefined>(
    options: TOptions,
    viewConfig?: SyncStoreViewConfig
): TOptions {
    const anyOptions = (options && typeof options === 'object' && !Array.isArray(options)) ? (options as any) : {}
    const base = (anyOptions.__atoma && typeof anyOptions.__atoma === 'object' && !Array.isArray(anyOptions.__atoma))
        ? anyOptions.__atoma
        : {}

    const requestedPersist = base.persist
    if (requestedPersist === 'direct') {
        throw new Error('[Atoma] Sync.Store: 不允许 direct persist（请使用 Store(...)）')
    }

    const requestedImplicit = base.allowImplicitFetchForWrite
    const viewAllowsImplicit = viewConfig?.allowImplicitFetchForWrite === true
    if (requestedImplicit === true && !viewAllowsImplicit) {
        throw new Error('[Atoma] Sync.Store: 当前写入策略禁止写入时隐式补读，请先 fetch/get 再写入')
    }

    const finalAllowImplicitFetchForWrite = typeof requestedImplicit === 'boolean'
        ? requestedImplicit
        : viewAllowsImplicit

    return {
        ...anyOptions,
        __atoma: {
            ...base,
            persist: 'outbox',
            allowImplicitFetchForWrite: finalAllowImplicitFetchForWrite
        }
    } as TOptions
}

export function createSyncStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>,
    viewConfig?: SyncStoreViewConfig
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
        addOne: (item: Partial<T>, options?: StoreOperationOptions) => addOneBase(item, withOutboxOptions(options, viewConfig)),
        addMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => addManyBase(items, withOutboxOptions(options, viewConfig)),
        updateOne: (id: StoreKey, recipe: any, options?: StoreOperationOptions) => updateOneBase(id, recipe, withOutboxOptions(options, viewConfig)),
        updateMany: (items: any, options?: StoreOperationOptions) => updateManyBase(items, withOutboxOptions(options, viewConfig)),
        deleteOne: (id: any, options?: StoreOperationOptions) => deleteOneBase(id, withOutboxOptions(options, viewConfig)),
        deleteMany: (items: any, options?: StoreOperationOptions) => deleteManyBase(items, withOutboxOptions(options, viewConfig)),
        upsertOne: (item: any, options?: StoreOperationOptions) => upsertOneBase(item, withOutboxOptions(options, viewConfig)),
        upsertMany: (items: any, options?: StoreOperationOptions) => upsertManyBase(items, withOutboxOptions(options, viewConfig)),

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
