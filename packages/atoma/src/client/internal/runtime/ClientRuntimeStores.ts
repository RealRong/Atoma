import { atom } from 'jotai/vanilla'
import type { CoreRuntime, Entity, IStore, StoreApi, StoreDataProcessor, StoreToken } from '#core'
import type { EntityId } from '#protocol'
import type { AtomaSchema } from '#client/types'
import type { ClientRuntimeStoresApi } from '#client/types/runtime'
import { StoreConfigResolver } from '#client/internal/runtime/StoreConfigResolver'
import { createStoreHandle } from '#core/store/internals/storeHandleManager'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import {
    createAddMany,
    createAddOne,
    createBatchGet,
    createDeleteMany,
    createDeleteOne,
    createFetchAll,
    createQuery,
    createQueryOne,
    createGetAll,
    createGetMany,
    createUpdateMany,
    createUpdateOne,
    createUpsertMany,
    createUpsertOne
} from '#core/store/ops'

type StoreListener = (store: StoreApi<any, any> & { name: string }) => void

const toStoreName = (name: unknown) => String(name)

type StoreEngine<T extends Entity = any> = Readonly<{
    handle: StoreHandle<T>
    api: StoreEngineApi<T>
}>

type StoreEngineApi<T extends Entity = any> = IStore<T, any> & Readonly<{
    fetchAll: () => Promise<T[]>
    query: (query: any) => Promise<any>
    queryOne: (query: any) => Promise<any>
}>

export class ClientRuntimeStores implements ClientRuntimeStoresApi {
    private readonly engineByName = new Map<string, StoreEngine<any>>()
    private readonly facadeByName = new Map<string, StoreApi<any, any> & { name: string }>()
    private readonly created: Array<StoreApi<any, any> & { name: string }> = []
    private readonly listeners = new Set<StoreListener>()
    private readonly configResolver: StoreConfigResolver

    constructor(
        private readonly runtime: CoreRuntime,
        private readonly args: {
            schema: AtomaSchema<any>
            dataProcessor?: StoreDataProcessor<any>
            defaults?: {
                idGenerator?: () => EntityId
            }
            ownerClient?: () => unknown
        }
    ) {
        this.configResolver = new StoreConfigResolver({
            schema: this.args.schema,
            clientRuntime: this.runtime as any,
            defaults: this.args.defaults,
            dataProcessor: this.args.dataProcessor
        })
    }

    private notifyCreated = (store: StoreApi<any, any> & { name: string }) => {
        this.created.push(store)
        for (const listener of this.listeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }

    private getFacade = (storeName: string): StoreApi<any, any> & { name: string } => {
        const key = toStoreName(storeName)
        const existing = this.facadeByName.get(key)
        if (existing) return existing

        const facade: any = {
            name: key,
            addOne: (item: any, options?: any) => this.ensureEngine(key).api.addOne(item, options),
            addMany: (items: any, options?: any) => this.ensureEngine(key).api.addMany(items, options),
            updateOne: (id: any, recipe: any, options?: any) => this.ensureEngine(key).api.updateOne(id, recipe, options),
            updateMany: (items: any, options?: any) => this.ensureEngine(key).api.updateMany(items, options),
            deleteOne: (id: any, options?: any) => this.ensureEngine(key).api.deleteOne(id, options),
            deleteMany: (ids: any, options?: any) => this.ensureEngine(key).api.deleteMany(ids, options),
            upsertOne: (item: any, options?: any) => this.ensureEngine(key).api.upsertOne(item, options),
            upsertMany: (items: any, options?: any) => this.ensureEngine(key).api.upsertMany(items, options),
            getOne: (id: any, options?: any) => this.ensureEngine(key).api.getOne(id, options),
            fetchOne: (id: any, options?: any) => this.ensureEngine(key).api.fetchOne(id, options),
            getAll: (filter?: any, cacheFilter?: any, options?: any) => this.ensureEngine(key).api.getAll(filter, cacheFilter, options),
            fetchAll: () => this.ensureEngine(key).api.fetchAll(),
            getMany: (ids: any, cache?: any, options?: any) => this.ensureEngine(key).api.getMany(ids, cache, options),
            query: (query: any) => this.ensureEngine(key).api.query(query),
            queryOne: (query: any) => this.ensureEngine(key).api.queryOne(query)
        }

        // Non-enumerable owner pointer for bindings (e.g. atoma-react) to locate the runtime/client.
        // This keeps StoreApi DX as CRUD-first while still allowing hooks to access runtime capabilities.
        Object.defineProperty(facade, 'client', {
            get: () => this.args.ownerClient?.(),
            enumerable: false,
            configurable: false
        })

        this.facadeByName.set(key, facade)
        return facade
    }

    private ensureEngine = (storeName: string): StoreEngine<any> => {
        const name = toStoreName(storeName)
        const existing = this.engineByName.get(name)
        if (existing) return existing

        const base = this.configResolver.resolve(name) as any

        this.runtime.observability.registerStore?.({
            storeName: name,
            debug: base.debug,
            debugSink: base.debugSink
        })

        const objectMapAtom = atom(new Map<EntityId, any>())
        const handle = createStoreHandle<any>({
            atom: objectMapAtom,
            jotaiStore: this.runtime.jotaiStore,
            config: {
                idGenerator: base.idGenerator,
                dataProcessor: base.dataProcessor,
                hooks: base.hooks,
                indexes: base.indexes,
                storeName: name,
                ...(base.write ? { write: base.write } : {})
            }
        })

        // Relations are lazy; cache compiled relation map per store handle.
        if (typeof base.relations === 'function') {
            let cache: any | undefined
            handle.relations = () => {
                if (!cache) cache = base.relations()
                return cache
            }
        }

        // Stage-3 stateless store: build ops against handle, but never expose a "stateful store object" to users.
        const addOne = createAddOne<any>(this.runtime, handle)
        const addMany = createAddMany<any>(this.runtime, handle)
        const updateOne = createUpdateOne<any>(this.runtime, handle)
        const updateMany = createUpdateMany<any>(this.runtime, handle)
        const deleteOne = createDeleteOne<any>(this.runtime, handle)
        const deleteMany = createDeleteMany<any>(this.runtime, handle)
        const upsertOne = createUpsertOne<any>(this.runtime, handle)
        const upsertMany = createUpsertMany<any>(this.runtime, handle)

        const getAll = createGetAll<any>(this.runtime, handle)
        const getMany = createGetMany<any>(this.runtime, handle)
        const { getOne, fetchOne } = createBatchGet(this.runtime as any, handle)
        const fetchAll = createFetchAll<any>(this.runtime, handle)
        const query = createQuery<any>(this.runtime, handle)
        const queryOne = createQueryOne<any>(this.runtime, handle)

        const api: StoreEngineApi<any> = {
            addOne,
            addMany,
            updateOne,
            updateMany,
            deleteOne,
            deleteMany,
            upsertOne,
            upsertMany,
            getOne,
            fetchOne,
            getAll,
            fetchAll,
            getMany,
            query,
            queryOne
        }

        // Register handle for storeKey-based resolution (new path).
        this.runtime.handles.set(this.runtime.toStoreKey(name), handle)

        const engine: StoreEngine<any> = { handle, api }
        this.engineByName.set(name, engine)

        // Notify only when the handle exists (so devtools/inspect can immediately read).
        this.notifyCreated(this.getFacade(name))

        return engine
    }

    resolveStore = (name: StoreToken): IStore<any> => {
        const key = toStoreName(name)
        // `resolveStore` is allowed to materialize the underlying handle/engine (used by core helpers).
        this.ensureEngine(key)
        return this.getFacade(key)
    }

    listStores = () => this.facadeByName.values()

    onStoreCreated = (listener: StoreListener, options?: { replay?: boolean }) => {
        if (options?.replay) {
            for (const store of this.created) {
                try {
                    listener(store)
                } catch {
                    // ignore
                }
            }
        }
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }
}
