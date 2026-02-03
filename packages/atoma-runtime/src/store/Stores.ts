import { atom } from 'jotai/vanilla'
import { Indexes, Query } from 'atoma-core'
import type * as Types from 'atoma-types/core'
import type { RuntimeSchema, StoreHandle, StoreRegistry } from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/protocol'
import { ConfigResolver } from './ConfigResolver'
import { StoreStateWriter } from './StoreStateWriter'
import type { CoreRuntime } from 'atoma-types/runtime'

type StoreListener = (store: Types.StoreApi<any, any> & { name: string }) => void

const toStoreName = (name: unknown) => String(name)

type StoreEngine<T extends Types.Entity = any> = Readonly<{
    handle: StoreHandle<T>
    api: StoreEngineApi<T>
}>

type StoreEngineApi<T extends Types.Entity = any> = Types.IStore<T, any> & Readonly<{
    fetchAll: () => Promise<T[]>
    query: (query: any) => Promise<any>
    queryOne: (query: any) => Promise<any>
}>

export class Stores implements StoreRegistry {
    private readonly engineByName = new Map<string, StoreEngine<any>>()
    private readonly facadeByName = new Map<string, Types.StoreApi<any, any> & { name: string }>()
    private readonly created: Array<Types.StoreApi<any, any> & { name: string }> = []
    private readonly listeners = new Set<StoreListener>()
    private readonly configResolver: ConfigResolver

    constructor(
        private readonly runtime: CoreRuntime,
        private readonly args: {
            schema: RuntimeSchema
            dataProcessor?: Types.StoreDataProcessor<any>
            defaults?: {
                idGenerator?: () => EntityId
            }
            ownerClient?: () => unknown
        }
    ) {
        this.configResolver = new ConfigResolver({
            schema: this.args.schema,
            runtime: this.runtime,
            defaults: this.args.defaults,
            dataProcessor: this.args.dataProcessor
        })
    }

    private notifyCreated = (store: Types.StoreApi<any, any> & { name: string }) => {
        this.created.push(store)
        for (const listener of this.listeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }

    private getFacade = (storeName: string): Types.StoreApi<any, any> & { name: string } => {
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

        const base = this.configResolver.resolve(name)

        this.runtime.observe.registerStore?.({
            storeName: name,
            debug: base.debug,
            debugSink: base.debugSink
        })

        const objectMapAtom = atom(new Map<EntityId, any>())
        const indexes = base.indexes && base.indexes.length ? new Indexes.StoreIndexes<any>(base.indexes) : null
        const matcher = Query.buildQueryMatcherOptions(base.indexes)

        let opSeq = 0
        const nextOpId = (prefix: 'q' | 'w') => {
            opSeq += 1
            return `${prefix}_${Date.now()}_${opSeq}`
        }

        const handle: StoreHandle<any> = {
            atom: objectMapAtom,
            jotaiStore: this.runtime.jotaiStore,
            storeName: name,
            defaultWriteStrategy: base.write?.strategy,
            indexes,
            matcher,
            hooks: base.hooks,
            idGenerator: base.idGenerator,
            dataProcessor: base.dataProcessor,
            stateWriter: null as any,
            nextOpId
        }
        handle.stateWriter = new StoreStateWriter(handle)

        // Relations are lazy; cache compiled relation map per store handle.
        if (typeof base.relations === 'function') {
            let cache: any | undefined
            handle.relations = () => {
                if (!cache) cache = base.relations()
                return cache
            }
        }

        // Stage-3 stateless store: build ops against handle, but never expose a "stateful store object" to users.
        // Write ops
        const addOne = (item: any, options?: any) => this.runtime.write.addOne(handle, item, options)
        const addMany = (items: any[], options?: any) => this.runtime.write.addMany(handle, items, options)
        const updateOne = (id: any, recipe: any, options?: any) => this.runtime.write.updateOne(handle, id, recipe, options)
        const updateMany = (items: any[], options?: any) => this.runtime.write.updateMany(handle, items, options)
        const deleteOne = (id: any, options?: any) => this.runtime.write.deleteOne(handle, id, options)
        const deleteMany = (ids: any[], options?: any) => this.runtime.write.deleteMany(handle, ids, options)
        const upsertOne = (item: any, options?: any) => this.runtime.write.upsertOne(handle, item, options)
        const upsertMany = (items: any[], options?: any) => this.runtime.write.upsertMany(handle, items, options)

        // Read ops
        const getAll = (filter?: any, cacheFilter?: any, options?: any) => this.runtime.read.getAll(handle, filter, cacheFilter, options)
        const getMany = (ids: any[], cache?: any, options?: any) => this.runtime.read.getMany(handle, ids, cache, options)
        const getOne = (id: any, options?: any) => this.runtime.read.getOne(handle, id, options)
        const fetchOne = (id: any, options?: any) => this.runtime.read.fetchOne(handle, id, options)
        const fetchAll = () => this.runtime.read.fetchAll(handle)
        const query = (query: any) => this.runtime.read.query(handle, query)
        const queryOne = (query: any) => this.runtime.read.queryOne(handle, query)

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

        const engine: StoreEngine<any> = { handle, api }
        this.engineByName.set(name, engine)

        // Notify only when the handle exists (so devtools/inspect can immediately read).
        this.notifyCreated(this.getFacade(name))

        return engine
    }

    resolve = (name: Types.StoreToken): Types.IStore<any> | undefined => {
        const key = toStoreName(name)
        return this.facadeByName.get(key)
    }

    ensure = (name: Types.StoreToken): Types.IStore<any> => {
        const key = toStoreName(name)
        this.ensureEngine(key)
        return this.getFacade(key)
    }

    list = () => this.facadeByName.values()

    onCreated = (listener: StoreListener, options?: { replay?: boolean }) => {
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

    resolveHandle = (name: Types.StoreToken, tag?: string): StoreHandle<any> => {
        const key = toStoreName(name)
        const existing = this.engineByName.get(key)
        if (existing) return existing.handle

        // Lazy creation for internal access.
        this.ensureEngine(key)
        const created = this.engineByName.get(key)
        if (created) return created.handle

        throw new Error(`[Atoma] ${tag || 'resolveHandle'}: 未找到 store handle（storeName=${key}）`)
    }
}
