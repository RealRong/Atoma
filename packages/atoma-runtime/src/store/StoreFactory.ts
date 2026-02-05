import { atom } from 'jotai/vanilla'
import { Indexes, Query, Relations } from 'atoma-core'
import type * as Types from 'atoma-types/core'
import { STORE_BINDINGS, type StoreBindings } from 'atoma-types/internal'
import type { RuntimeSchema, StoreHandle } from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime } from 'atoma-types/runtime'
import { StoreStateWriter } from './StoreStateWriter'

export type StoreEngineApi<T extends Types.Entity = any> = Types.IStore<T, any> & Readonly<{
    fetchAll: () => Promise<T[]>
    query: (query: any) => Promise<any>
    queryOne: (query: any) => Promise<any>
}>

export type StoreEngine<T extends Types.Entity = any> = Readonly<{
    handle: StoreHandle<T>
    api: StoreEngineApi<T>
}>

export type StoreFacade = Types.StoreApi<any, any> & { name: string }

export type StoreFactoryResult<T extends Types.Entity = any> = Readonly<{
    handle: StoreHandle<T>
    api: StoreEngineApi<T>
    facade: StoreFacade
}>

export class StoreFactory {
    private readonly runtime: CoreRuntime
    private readonly schema: RuntimeSchema
    private readonly defaults?: {
        idGenerator?: () => EntityId
    }
    private readonly dataProcessor?: Types.StoreDataProcessor<any>
    constructor(args: {
        runtime: CoreRuntime
        schema: RuntimeSchema
        defaults?: {
            idGenerator?: () => EntityId
        }
        dataProcessor?: Types.StoreDataProcessor<any>
    }) {
        this.runtime = args.runtime
        this.schema = args.schema
        this.defaults = args.defaults
        this.dataProcessor = args.dataProcessor
    }

    build = (storeName: string): StoreFactoryResult<any> => {
        const name = String(storeName)
        const storeSchema = this.schema?.[name] ?? {}

        const idGenerator = storeSchema?.idGenerator ?? this.defaults?.idGenerator
        const dataProcessor = this.mergeDataProcessor(this.dataProcessor, storeSchema?.dataProcessor)

        const relationsFactory = storeSchema?.relations
            ? () => Relations.compileRelationsMap(storeSchema.relations, name)
            : undefined

        const objectMapAtom = atom(new Map<EntityId, any>())
        const indexes = storeSchema.indexes && storeSchema.indexes.length ? new Indexes.StoreIndexes<any>(storeSchema.indexes) : null
        const matcher = Query.buildQueryMatcherOptions(storeSchema.indexes)

        let opSeq = 0
        const nextOpId = (prefix: 'q' | 'w') => {
            opSeq += 1
            return `${prefix}_${Date.now()}_${opSeq}`
        }

        const handle: StoreHandle<any> = {
            atom: objectMapAtom,
            jotaiStore: this.runtime.jotaiStore,
            storeName: name,
            defaultWriteStrategy: storeSchema.write?.strategy,
            indexes,
            matcher,
            hooks: storeSchema.hooks,
            idGenerator,
            dataProcessor,
            stateWriter: null as any,
            nextOpId
        }
        handle.stateWriter = new StoreStateWriter(handle)

        if (typeof relationsFactory === 'function') {
            let cache: any | undefined
            handle.relations = () => {
                if (!cache) cache = relationsFactory()
                return cache
            }
        }

        const addOne = (item: any, options?: any) => this.runtime.write.addOne(handle, item, options)
        const addMany = (items: any[], options?: any) => this.runtime.write.addMany(handle, items, options)
        const updateOne = (id: any, recipe: any, options?: any) => this.runtime.write.updateOne(handle, id, recipe, options)
        const updateMany = (items: any[], options?: any) => this.runtime.write.updateMany(handle, items, options)
        const deleteOne = (id: any, options?: any) => this.runtime.write.deleteOne(handle, id, options)
        const deleteMany = (ids: any[], options?: any) => this.runtime.write.deleteMany(handle, ids, options)
        const upsertOne = (item: any, options?: any) => this.runtime.write.upsertOne(handle, item, options)
        const upsertMany = (items: any[], options?: any) => this.runtime.write.upsertMany(handle, items, options)

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

        const facade: StoreFacade = this.createFacade(name, api)
        const bindings = this.createBindings(name, handle)
        Object.defineProperty(facade, STORE_BINDINGS, {
            value: bindings,
            enumerable: false,
            configurable: false
        })

        return { handle, api, facade }
    }

    private createFacade = (storeName: string, api: StoreEngineApi<any>): StoreFacade => {
        const facade: any = {
            name: storeName,
            addOne: (item: any, options?: any) => api.addOne(item, options),
            addMany: (items: any, options?: any) => api.addMany(items, options),
            updateOne: (id: any, recipe: any, options?: any) => api.updateOne(id, recipe, options),
            updateMany: (items: any, options?: any) => api.updateMany(items, options),
            deleteOne: (id: any, options?: any) => api.deleteOne(id, options),
            deleteMany: (ids: any, options?: any) => api.deleteMany(ids, options),
            upsertOne: (item: any, options?: any) => api.upsertOne(item, options),
            upsertMany: (items: any, options?: any) => api.upsertMany(items, options),
            getOne: (id: any, options?: any) => api.getOne(id, options),
            fetchOne: (id: any, options?: any) => api.fetchOne(id, options),
            getAll: (filter?: any, cacheFilter?: any, options?: any) => api.getAll(filter, cacheFilter, options),
            fetchAll: () => api.fetchAll(),
            getMany: (ids: any, cache?: any, options?: any) => api.getMany(ids, cache, options),
            query: (query: any) => api.query(query),
            queryOne: (query: any) => api.queryOne(query)
        }
        return facade as StoreFacade
    }

    private createBindings = (storeName: string, handle: StoreHandle<any>): StoreBindings<any> => {
        const source = {
            getSnapshot: () => handle.jotaiStore.get(handle.atom) as ReadonlyMap<EntityId, any>,
            subscribe: (listener: () => void) => {
                const s: any = handle.jotaiStore
                if (typeof s?.sub !== 'function') return () => {}
                return s.sub(handle.atom, () => listener())
            }
        }

        const hydrate = async (items: any[]) => {
            if (!items.length) return

            const processed = (await Promise.all(items.map(async (item) => this.runtime.transform.writeback(handle, item))))
                .filter(Boolean) as any[]

            if (!processed.length) return

            const before = handle.jotaiStore.get(handle.atom) as Map<any, any>
            const after = new Map(before)
            const changedIds = new Set<any>()

            processed.forEach(item => {
                const prev = before.get(item.id)
                after.set(item.id, item)
                if (prev !== item) changedIds.add(item.id)
            })

            if (!changedIds.size) return

            handle.jotaiStore.set(handle.atom, after)
            handle.indexes?.applyChangedIds(before, after, changedIds)
        }

        return {
            name: storeName,
            cacheKey: this.runtime as unknown as object,
            source,
            indexes: handle.indexes,
            matcher: handle.matcher,
            relations: () => handle.relations?.(),
            ensureStore: (name: Types.StoreToken) => this.runtime.stores.ensure(String(name)),
            hydrate
        }
    }

    private mergeDataProcessor = <T>(
        base?: Types.StoreDataProcessor<T>,
        override?: Types.StoreDataProcessor<T>
    ): Types.StoreDataProcessor<T> | undefined => {
        if (!base && !override) return undefined
        return {
            ...(base ?? {}),
            ...(override ?? {})
        } as Types.StoreDataProcessor<T>
    }
}
