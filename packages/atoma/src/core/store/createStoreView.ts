import type { CoreStore } from '../createStore'
import type { CoreRuntime, Entity, RelationConfig, StoreOperationOptions } from '../types'
import type { EntityId } from '#protocol'
import { storeHandleManager } from './internals/storeHandleManager'
import type { StoreWriteConfig } from './internals/storeWriteEngine'
import type { StoreHandle } from './internals/handleTypes'
import {
    createAddMany,
    createAddOne,
    createBatchGet,
    createCreateServerAssignedMany,
    createCreateServerAssignedOne,
    createDeleteMany,
    createDeleteOne,
    createFetchAll,
    createFindMany,
    createGetAll,
    createGetMany,
    createUpdateMany,
    createUpdateOne,
    createUpsertMany,
    createUpsertOne
} from './ops'

export type StoreViewConfig = {
    writeConfig?: StoreWriteConfig
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
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    config?: StoreViewConfig
): CoreStore<T, Relations> {
    const name = String(handle.storeName || 'store')
    const includeServerAssignedCreate = config?.includeServerAssignedCreate !== false

    const allowImplicitFetchForWrite = handle.writePolicies?.allowImplicitFetchForWrite !== false
    const writeConfig: StoreWriteConfig = config?.writeConfig ?? {
        writeStrategy: undefined,
        allowImplicitFetchForWrite
    }

    const addOneBase = createAddOne<T>(clientRuntime, handle, writeConfig)
    const addManyBase = createAddMany<T>(clientRuntime, handle, writeConfig)
    const updateOneBase = createUpdateOne<T>(clientRuntime, handle, writeConfig)
    const updateManyBase = createUpdateMany<T>(clientRuntime, handle, writeConfig)
    const deleteOneBase = createDeleteOne<T>(clientRuntime, handle, writeConfig)
    const deleteManyBase = createDeleteMany<T>(clientRuntime, handle, writeConfig)
    const upsertOneBase = createUpsertOne<T>(clientRuntime, handle, writeConfig)
    const upsertManyBase = createUpsertMany<T>(clientRuntime, handle, writeConfig)

    const createServerAssignedOneBase = includeServerAssignedCreate ? createCreateServerAssignedOne<T>(clientRuntime, handle) : null
    const createServerAssignedManyBase = includeServerAssignedCreate ? createCreateServerAssignedMany<T>(clientRuntime, handle) : null

    const getAll = createGetAll<T>(clientRuntime, handle)
    const getMany = createGetMany<T>(clientRuntime, handle)
    const { getOne, fetchOne } = createBatchGet(clientRuntime, handle)
    const fetchAll = createFetchAll<T>(clientRuntime, handle)
    const findMany = createFindMany<T>(clientRuntime, handle)

    const store: any = {
        addOne: (item: Partial<T>, options?: StoreOperationOptions) => addOneBase(item, options),
        addMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => addManyBase(items, options),
        updateOne: (id: EntityId, recipe: any, options?: StoreOperationOptions) => updateOneBase(id, recipe, options),
        updateMany: (items: any, options?: StoreOperationOptions) => updateManyBase(items, options),
        deleteOne: (id: any, options?: StoreOperationOptions) => deleteOneBase(id, options),
        deleteMany: (items: any, options?: StoreOperationOptions) => deleteManyBase(items, options),
        upsertOne: (item: any, options?: any) => upsertOneBase(item, options),
        upsertMany: (items: any, options?: StoreOperationOptions) => upsertManyBase(items, options),

        ...(includeServerAssignedCreate ? {
            createServerAssignedOne: (item: Partial<T>, options?: StoreOperationOptions) => (createServerAssignedOneBase as any)(item, options),
            createServerAssignedMany: (items: Array<Partial<T>>, options?: StoreOperationOptions) => (createServerAssignedManyBase as any)(items, options)
        } : {}),

        getAll,
        getMany,
        getOne,
        fetchOne,
        fetchAll,
        findMany
    } satisfies Partial<CoreStore<T, Relations>>

    store.name = name

    store.peek = (id: EntityId) => {
        return handle.jotaiStore.get(handle.atom).get(id)
    }

    store.peekAll = () => {
        return Array.from(handle.jotaiStore.get(handle.atom).values())
    }

    store.reset = () => {
        const before = handle.jotaiStore.get(handle.atom)
        if (!before.size) return
        const after = new Map<EntityId, T>()
        handle.jotaiStore.set(handle.atom, after)
        handle.indexes?.applyMapDiff(before, after)
    }

    store.withRelations = <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => {
        applyRelations(handle, factory)
        return store as unknown as CoreStore<T, NewRelations>
    }

    storeHandleManager.attachStoreHandle(store as any, handle)
    storeHandleManager.attachStoreRuntime(store as any, clientRuntime)
    return store as CoreStore<T, Relations>
}
