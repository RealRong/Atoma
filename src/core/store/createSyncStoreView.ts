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

type SyncStoreWriteMode = 'intent-only' | 'local-first'

type SyncStoreViewConfig = {
    /**
     * queued 写入策略：
     * - intent-only（默认）：只入队；禁止 cache miss 隐式补读
     * - local-first：先本地 durable 再入队；允许本地 cache miss 隐式补读
     */
    mode?: SyncStoreWriteMode
}

function assertNoInternalOptions(options: unknown): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return
    if ('__atoma' in (options as any)) {
        throw new Error('[Atoma] Sync.Store: options.__atoma 为内部保留字段，请勿传入；需要 direct 请使用 Store(...)')
    }
}

function toSyncOptions(options: StoreOperationOptions | undefined, mode: SyncStoreWriteMode): StoreOperationOptions {
    assertNoInternalOptions(options)
    return {
        ...(options ? options : {}),
        __atoma: {
            persist: 'outbox',
            allowImplicitFetchForWrite: mode === 'local-first'
        }
    }
}

export function createSyncStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>,
    viewConfig?: SyncStoreViewConfig
): SyncStore<T, Relations> {
    const name = String(handle.storeName || 'store')
    const mode: SyncStoreWriteMode = viewConfig?.mode ?? 'intent-only'

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
        addOne: (item: Partial<T>, options?: StoreOperationOptions) => addOneBase(item, toSyncOptions(options, mode)),
        addMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => addManyBase(items, toSyncOptions(options, mode)),
        updateOne: (id: StoreKey, recipe: any, options?: StoreOperationOptions) => updateOneBase(id, recipe, toSyncOptions(options, mode)),
        updateMany: (items: any, options?: StoreOperationOptions) => updateManyBase(items, toSyncOptions(options, mode)),
        deleteOne: (id: any, options?: StoreOperationOptions) => deleteOneBase(id, toSyncOptions(options, mode)),
        deleteMany: (items: any, options?: StoreOperationOptions) => deleteManyBase(items, toSyncOptions(options, mode)),
        upsertOne: (item: any, options?: StoreOperationOptions) => upsertOneBase(item, toSyncOptions(options, mode)),
        upsertMany: (items: any, options?: StoreOperationOptions) => upsertManyBase(items, toSyncOptions(options, mode)),

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
