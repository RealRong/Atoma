import { PrimitiveAtom } from 'jotai/vanilla'
import { BaseStore, bumpAtomVersion, globalStore } from './BaseStore'
import { applyQuery } from './query'
import { IndexManager } from './indexes/IndexManager'
import { IndexSynchronizer } from './indexes/IndexSynchronizer'
import { createStoreContext } from './StoreContext'
import type { QueryMatcherOptions } from './query/QueryMatcher'
import { createTraceId } from '../observability/trace'
import { createDebugEmitter } from '../observability/debug'
import { attachDebugCarrier } from '../observability/internal'
import {
    IAdapter,
    FindManyOptions,
    IStore,
    LifecycleHooks,
    PartialWithId,
    SchemaValidator,
    StoreConfig,
    StoreKey,
    StoreOperationOptions,
    Entity
} from './types'
import { registerGlobalIndex } from '../devtools/global'

type GetOneTask = {
    id: StoreKey
    resolve: (value: any) => void
}

/**
 * Initialize a local store with an adapter
 */
export function initializeLocalStore<T extends Entity>(
    atom: PrimitiveAtom<Map<StoreKey, T>>,
    adapter: IAdapter<T>,
    config?: StoreConfig<T>
): IStore<T> {
    // Use custom store or global store
    const jotaiStore = config?.store || globalStore
    const context = config?.context || createStoreContext()
    if (config?.storeName && !context.storeName) {
        context.storeName = config.storeName
    }
    if (config?.debug && !context.debug) {
        context.debug = config.debug as any
    }

    const resolveOperationTraceId = (options?: StoreOperationOptions) => {
        const explicit = options?.debug?.traceId
        if (typeof explicit === 'string' && explicit) return explicit
        const debug = context.debug as any
        const enabled = Boolean(debug?.enabled && debug?.sink)
        const sampleRate = typeof debug?.sampleRate === 'number' ? debug.sampleRate : 0
        if (!enabled || sampleRate <= 0) return undefined
        return createTraceId()
    }

    let batchGetOneTaskQueue: GetOneTask[] = []
    let batchFetchOneTaskQueue: GetOneTask[] = []
    const indexManager = config?.indexes && config.indexes.length ? new IndexManager<T>(config.indexes) : null
    if (indexManager) {
        context.indexRegistry.register(atom, indexManager)
    }
    const matcher: QueryMatcherOptions | undefined = (() => {
        const defs = config?.indexes || []
        if (!defs.length) return undefined
        const fields: QueryMatcherOptions['fields'] = {}
        defs.forEach(def => {
            if (def.type !== 'text') return
            fields[def.field] = {
                match: {
                    minTokenLength: def.options?.minTokenLength,
                    tokenizer: def.options?.tokenizer
                },
                fuzzy: {
                    distance: def.options?.fuzzyDistance,
                    minTokenLength: def.options?.minTokenLength,
                    tokenizer: def.options?.tokenizer
                }
            }
        })
        return Object.keys(fields).length ? { fields } : undefined
    })()

    const indexSnapshotRegister = () => {
        if (!indexManager) return undefined
        const name = config?.storeName || 'store'
        const snapshot = () => {
            const indexes = indexManager.getIndexSnapshots().map(s => ({
                field: s.field,
                type: s.type,
                dirty: s.dirty,
                size: s.totalDocs,
                distinctValues: s.distinctValues,
                avgSetSize: s.avgSetSize,
                maxSetSize: s.maxSetSize,
                minSetSize: s.minSetSize
            }))

            return { name, indexes, lastQuery: indexManager.getLastQueryPlan() }
        }
        return (
            config?.devtools?.registerIndexManager?.({ name, snapshot }) ||
            registerGlobalIndex({ name, snapshot })
        )
    }

    const stopIndexDevtools = indexSnapshotRegister()

    // Helper to transform data if configured
    const transform = (item: T): T => {
        return config?.transformData ? config.transformData(item) : item
    }

    const validateWithSchema = async (item: T, schema?: SchemaValidator<T>): Promise<T> => {
        if (!schema) return item
        try {
            // Zod safeParse
            if ((schema as any).safeParse) {
                const result = (schema as any).safeParse(item)
                if (!result.success) {
                    throw new Error((result.error || 'Schema validation failed') as any)
                }
                return result.data as T
            }
            // Zod parse
            if ((schema as any).parse) {
                return (schema as any).parse(item)
            }
            // Yup validateSync
            if ((schema as any).validateSync) {
                return (schema as any).validateSync(item)
            }
            // Yup validate (async)
            if ((schema as any).validate) {
                return await (schema as any).validate(item)
            }
            // Function validator
            if (typeof schema === 'function') {
                return await (schema as any)(item)
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            throw err
        }
        return item
    }

    const hooks: LifecycleHooks<T> | undefined = config?.hooks

    const runBeforeSave = async (item: PartialWithId<T>, action: 'add' | 'update') => {
        if (hooks?.beforeSave) {
            return await hooks.beforeSave({ action, item })
        }
        return item
    }

    const runAfterSave = async (item: PartialWithId<T>, action: 'add' | 'update') => {
        if (hooks?.afterSave) {
            await hooks.afterSave({ action, item })
        }
    }

    // Process batched getOne requests
    const processGetOneTaskQueue = async () => {
        if (batchGetOneTaskQueue.length) {
            const sliced = batchGetOneTaskQueue.slice()
            batchGetOneTaskQueue = []

            const ids = Array.from(new Set(sliced.map(i => i.id)).values())
            let items = (await adapter.bulkGet(ids)).filter((i): i is T => i !== undefined)

            // Apply transformation
            items = items.map(transform)

            const idToItem = Object.fromEntries(items.map(i => [(i as any).id, i]))

            sliced.forEach(task => {
                const item = idToItem[task.id]
                task.resolve(item)
            })

            // Update atom cache (incremental add avoids full index rebuild)
            const before = jotaiStore.get(atom)
            const after = BaseStore.bulkAdd(items as PartialWithId<T>[], before)
            jotaiStore.set(atom, after)
            if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, before, after)
            bumpAtomVersion(atom, undefined, context)
        }
    }

    // Process batched fetchOne requests (bypass cache)
    const processFetchOneTaskQueue = async () => {
        if (batchFetchOneTaskQueue.length) {
            const sliced = batchFetchOneTaskQueue.slice()
            batchFetchOneTaskQueue = []

            const ids = Array.from(new Set(sliced.map(i => i.id)).values())
            let items = (await adapter.bulkGet(ids)).filter((i): i is T => i !== undefined)

            // Apply transformation
            items = items.map(transform)

            const idToItem = Object.fromEntries(items.map(i => [(i as any).id, i]))

            sliced.forEach(task => {
                const item = idToItem[task.id]
                task.resolve(item)
            })
        }
    }

    // Batch getOne calls
    const handleGetOne = async (id: StoreKey, resolve: (v: T | undefined) => void) => {
        if (batchGetOneTaskQueue.length) {
            batchGetOneTaskQueue.push({ resolve, id })
        } else {
            batchGetOneTaskQueue = [{ resolve, id }]
            Promise.resolve().then(() => {
                processGetOneTaskQueue()
            })
        }
    }

    // Batch fetchOne calls
    const handleFetchOne = async (id: StoreKey, resolve: (v: T | undefined) => void) => {
        if (batchFetchOneTaskQueue.length) {
            batchFetchOneTaskQueue.push({ resolve, id })
        } else {
            batchFetchOneTaskQueue = [{ resolve, id }]
            Promise.resolve().then(() => {
                processFetchOneTaskQueue()
            })
        }
    }

    const store: IStore<T> = {
        addOne: (obj, options) => {
            return new Promise((resolve, reject) => {
                const prepare = async () => {
                    let initedObj = BaseStore.initBaseObject(obj, config?.idGenerator) as unknown as PartialWithId<T>
                    initedObj = await runBeforeSave(initedObj, 'add')
                    initedObj = transform(initedObj as T) as unknown as PartialWithId<T>
                    initedObj = await validateWithSchema(initedObj as T, config?.schema) as unknown as PartialWithId<T>
                    return initedObj
                }

                prepare().then(validObj => {
                    BaseStore.dispatch<T>({
                        type: 'add',
                        data: validObj as PartialWithId<T>,
                        adapter,
                        atom,
                        store: jotaiStore,
                        context,
                        traceId: resolveOperationTraceId(options),
                        onSuccess: async o => {
                            await runAfterSave(validObj, 'add')
                            resolve(o)
                        },
                        onFail: (error) => {
                            reject(error || new Error(`Failed to add item with id ${(validObj as any).id}`))
                        }
                    })
                }).catch(reject)
            })
        },

        deleteOneById: (id, options) => {
            return new Promise((resolve, reject) => {
                const oldItem = jotaiStore.get(atom).get(id)
                BaseStore.dispatch({
                    type: options?.force ? 'forceRemove' : 'remove',
                    data: { id } as PartialWithId<T>,
                    adapter,
                    atom,
                    store: jotaiStore,
                    context,
                    traceId: resolveOperationTraceId(options),
                    onSuccess: () => {
                        resolve(true)
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to delete item with id ${id}`))
                    }
                })
            })
        },

        getAll: async (filter, cacheFilter) => {
            const existingMap = jotaiStore.get(atom)
            let arr = await adapter.getAll(filter)

            // Apply transformation
            arr = arr.map(transform)

            // Determine removals (remote source of truth)
            const incomingIds = new Set(arr.map(i => (i as any).id as StoreKey))
            const toRemove: StoreKey[] = []
            existingMap.forEach((_value: T, id: StoreKey) => {
                if (!incomingIds.has(id)) toRemove.push(id)
            })

            // Apply cache filter if provided
            const itemsToCache = cacheFilter ? arr.filter(cacheFilter) : arr

            const withRemovals = BaseStore.bulkRemove(toRemove, existingMap)
            const next = BaseStore.bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
            jotaiStore.set(atom, next)
            if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, existingMap, next)
            bumpAtomVersion(atom, undefined, context)

            return arr
        },

        getMultipleByIds: async (ids, cache = true) => {
            const map = jotaiStore.get(atom)

            const hitMap = new Map<StoreKey, T>()
            const missing: StoreKey[] = []

            ids.forEach(id => {
                if (map.has(id)) {
                    hitMap.set(id, map.get(id) as T)
                } else {
                    missing.push(id)
                }
            })

            let fetched: T[] = []

            if (missing.length > 0) {
                fetched = (await adapter.bulkGet(missing)).filter((i): i is T => i !== undefined)
                fetched = fetched.map(transform)

                if (cache && fetched.some(i => !map.has((i as any).id))) {
                    const before = jotaiStore.get(atom)
                    const after = BaseStore.bulkAdd(fetched as PartialWithId<T>[], before)
                    jotaiStore.set(atom, after)
                    if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, before, after)
                    bumpAtomVersion(atom, undefined, context)
                }
            }

            const fetchedMap = new Map<StoreKey, T>(fetched.map(item => [(item as any).id, item]))

            return ids
                .map(id => hitMap.get(id) ?? fetchedMap.get(id))
                .filter((i): i is T => i !== undefined)
        },

        getOneById: (id) => {
            return new Promise(resolve => {
                const atomOne = jotaiStore.get(atom).get(id)
                if (atomOne) {
                    resolve(atomOne)
                } else {
                    handleGetOne(id, resolve)
                }
            })
        },

        fetchOneById: id => {
            return new Promise(resolve => {
                handleFetchOne(id, resolve)
            })
        },

        updateOne: (obj, options) => {
            return new Promise((resolve, reject) => {
                if (jotaiStore.get(atom).has(obj.id)) {
                    const base = jotaiStore.get(atom).get(obj.id)! as unknown as PartialWithId<T>
                    const prepare = async () => {
                        let merged = Object.assign({}, base, obj, { updatedAt: Date.now(), createdAt: (base as any).createdAt ?? Date.now(), id: obj.id }) as PartialWithId<T>
                        merged = await runBeforeSave(merged, 'update')
                        merged = transform(merged as T) as unknown as PartialWithId<T>
                        merged = await validateWithSchema(merged as T, config?.schema) as unknown as PartialWithId<T>
                        return merged
                    }

                    prepare().then(validObj => {
                        BaseStore.dispatch({
                            type: 'update',
                            atom,
                            adapter,
                            data: validObj,
                            store: jotaiStore,
                            context,
                            traceId: resolveOperationTraceId(options),
                            onSuccess: async updated => {
                                await runAfterSave(validObj, 'update')
                                resolve(updated)
                            },
                            onFail: (error) => {
                                reject(error || new Error(`Failed to update item with id ${obj.id}`))
                            }
                        })
                    }).catch(reject)
                } else {
                    // Fetch from adapter first
                    adapter.get(obj.id).then(data => {
                        if (data) {
                            // Transform and validate fetched data before caching
                            const transformed = transform(data)

                            validateWithSchema(transformed, config?.schema)
                                .then(validFetched => {
                                    const before = jotaiStore.get(atom)
                                    const after = BaseStore.add(validFetched as PartialWithId<T>, before)
                                    jotaiStore.set(atom, after)
                                    if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, before, after)
                                    bumpAtomVersion(atom, undefined, context)

                                    const prepare = async () => {
                                        const base = validFetched as unknown as PartialWithId<T>
                                        let merged = Object.assign({}, base, obj, { updatedAt: Date.now(), createdAt: (base as any).createdAt ?? Date.now(), id: obj.id }) as PartialWithId<T>
                                        merged = await runBeforeSave(merged, 'update')
                                        merged = transform(merged as T) as unknown as PartialWithId<T>
                                        merged = await validateWithSchema(merged as T, config?.schema) as unknown as PartialWithId<T>
                                        return { merged, base }
                                    }

                                    prepare().then(({ merged: validObj, base }) => {
                                        BaseStore.dispatch({
                                            type: 'update',
                                            data: validObj,
                                            atom,
                                            adapter,
                                            store: jotaiStore,
                                            context,
                                            traceId: resolveOperationTraceId(options),
                                            onSuccess: async updated => {
                                                await runAfterSave(validObj, 'update')
                                                resolve(updated)
                                            },
                                            onFail: (error) => {
                                                reject(error || new Error(`Failed to update item with id ${obj.id}`))
                                            }
                                        })
                                    }).catch(reject)
                                })
                                .catch(err => reject(err))
                        } else {
                            reject(new Error(`Item with id ${obj.id} not found`))
                        }
                    }).catch(error => {
                        reject(error)
                    })
                }
            })
        },

        findMany: async (options?: FindManyOptions<T>) => {
            // If incoming item is shallow-equal to cached value, reuse cached reference to avoid unnecessary re-renders.
            const preserveReference = (incoming: T): T => {
                const existing = jotaiStore.get(atom).get((incoming as any).id)
                if (!existing) return incoming
                const keys = new Set([...Object.keys(existing as any), ...Object.keys(incoming as any)])
                for (const key of keys) {
                    if ((existing as any)[key] !== (incoming as any)[key]) {
                        return incoming
                    }
                }
                return existing
            }

            const debugOptions = context.debug as any
            const explainEnabled = options?.debug?.explain === true
            const storeName = context.storeName || config?.storeName || 'store'
            const effectiveSkipStore = Boolean(options?.skipStore || (options as any)?.fields?.length)

            const shouldAllocateTrace = explainEnabled || (
                Boolean(debugOptions?.enabled && debugOptions?.sink) && (debugOptions?.sampleRate ?? 0) > 0
            )
            const traceId = options?.debug?.traceId || (shouldAllocateTrace ? createTraceId() : undefined)
            const optionsWithTrace = traceId
                ? ({
                    ...(options || {}),
                    debug: {
                        ...((options as any)?.debug || {}),
                        traceId
                    }
                } as FindManyOptions<T>)
                : options
            const explain = explainEnabled
                ? { schemaVersion: 1, traceId: traceId || createTraceId() }
                : undefined

            const emitter = createDebugEmitter({ debug: debugOptions, traceId, store: storeName })
            if (emitter && optionsWithTrace && typeof optionsWithTrace === 'object') {
                attachDebugCarrier(optionsWithTrace as any, { emitter })
            }
            const emit = (type: string, payload: any) => emitter?.emit(type, payload)

            const summarizeParams = (opts?: FindManyOptions<T>) => {
                if (!opts) return {}
                const where = opts.where
                const whereFields = (where && typeof where === 'object' && !Array.isArray(where))
                    ? Object.keys(where as any)
                    : undefined
                const orderBy = opts.orderBy
                const orderByFields = orderBy
                    ? (Array.isArray(orderBy) ? orderBy : [orderBy]).map(r => String((r as any).field))
                    : undefined
                return {
                    whereFields,
                    orderByFields,
                    limit: typeof opts.limit === 'number' ? opts.limit : undefined,
                    offset: typeof opts.offset === 'number' ? opts.offset : undefined,
                    before: typeof (opts as any).before === 'string' ? (opts as any).before : undefined,
                    after: typeof (opts as any).after === 'string' ? (opts as any).after : undefined,
                    cursor: typeof (opts as any).cursor === 'string' ? (opts as any).cursor : undefined,
                    includeTotal: typeof (opts as any).includeTotal === 'boolean' ? (opts as any).includeTotal : undefined,
                    fields: Array.isArray((opts as any).fields) ? (opts as any).fields : undefined,
                    skipStore: Boolean((opts as any).skipStore)
                }
            }

            const withExplain = (out: any, extra?: any) => {
                if (!explainEnabled) return out
                return { ...out, explain: { ...explain, ...(extra || {}) } }
            }

            const evaluateWithIndexes = (mapRef: Map<StoreKey, T>, opts?: FindManyOptions<T>) => {
                const candidateRes = indexManager ? indexManager.collectCandidates(opts?.where) : { kind: 'unsupported' as const }
                const plan = indexManager?.getLastQueryPlan()

                emit('query:index', {
                    params: { whereFields: summarizeParams(opts).whereFields },
                    result: candidateRes.kind === 'candidates'
                        ? { kind: 'candidates', exactness: candidateRes.exactness, count: candidateRes.ids.size }
                        : { kind: candidateRes.kind },
                    plan
                })

                if (explain) {
                    ;(explain as any).index = {
                        kind: candidateRes.kind,
                        ...(candidateRes.kind === 'candidates' ? { exactness: candidateRes.exactness, candidates: candidateRes.ids.size } : {}),
                        ...(plan ? { lastQueryPlan: plan } : {})
                    }
                }

                if (candidateRes.kind === 'empty') {
                    emit('query:finalize', { inputCount: 0, outputCount: 0, params: summarizeParams(opts) })
                    if (explain) {
                        ;(explain as any).finalize = { inputCount: 0, outputCount: 0, paramsSummary: summarizeParams(opts) }
                    }
                    return [] as T[]
                }

                const source =
                    candidateRes.kind === 'candidates'
                        ? Array.from(candidateRes.ids).map(id => mapRef.get(id) as T).filter(Boolean)
                        : Array.from(mapRef.values()) as T[]
                const out = applyQuery(source as any, opts, { preSorted: false, matcher }) as T[]

                emit('query:finalize', { inputCount: source.length, outputCount: out.length, params: summarizeParams(opts) })
                if (explain) {
                    ;(explain as any).finalize = { inputCount: source.length, outputCount: out.length, paramsSummary: summarizeParams(opts) }
                }
                return out
            }

            // Compute from current cache for即时 UI
            const map = jotaiStore.get(atom)
            emit('query:start', { params: summarizeParams(options) })
            const localResult = withExplain(
                { data: evaluateWithIndexes(map, options) },
                { cacheWrite: { writeToCache: !effectiveSkipStore, reason: effectiveSkipStore ? (options?.skipStore ? 'skipStore' : 'sparseFields') : undefined } }
            )

            const normalizeResult = (res: any): { data: T[]; pageInfo?: any; explain?: any } => {
                if (res && typeof res === 'object' && !Array.isArray(res)) {
                    if (Array.isArray((res as any).data)) {
                        return { data: (res as any).data, pageInfo: (res as any).pageInfo, explain: (res as any).explain }
                    }
                }
                if (Array.isArray(res)) return { data: res }
                return { data: [] }
            }

            // Prefer adapter-level findMany when可用（支持远程过滤/分页）
            if (typeof (adapter as any).findMany === 'function') {
                try {
                    const startedAt = Date.now()
                    const raw = await (adapter as any).findMany(optionsWithTrace)
                    const durationMs = Date.now() - startedAt
                    const normalized = normalizeResult(raw)
                    const { data, pageInfo, explain: adapterExplain } = normalized

                    const transformed = (data || []).map((item: T) => transform(item))

                    if (effectiveSkipStore) {
                        emit('query:cacheWrite', {
                            writeToCache: false,
                            reason: options?.skipStore ? 'skipStore' : 'sparseFields',
                            params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields }
                        })
                        return withExplain({
                            data: transformed,
                            pageInfo,
                            ...(adapterExplain !== undefined ? { explain: adapterExplain } : {})
                        }, {
                            cacheWrite: { writeToCache: false, reason: options?.skipStore ? 'skipStore' : 'sparseFields' },
                            adapter: { ok: true, durationMs },
                            ...(adapterExplain !== undefined ? { adapterRemoteExplain: adapterExplain } : {})
                        })
                    }

                    const existingMap = jotaiStore.get(atom)
                    const next = new Map(existingMap)
                    // Apply referential equality check only if we are using the store
                    const processed = transformed.map((item: T) => preserveReference(item))

                    processed.forEach((item: T) => {
                        const id = (item as any).id as StoreKey
                        next.set(id, item)
                    })

                    jotaiStore.set(atom, next)
                    if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, existingMap, next)
                    bumpAtomVersion(atom, undefined, context)

                    emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })
                    return withExplain({
                        data: transformed,
                        pageInfo,
                        ...(adapterExplain !== undefined ? { explain: adapterExplain } : {})
                    }, {
                        cacheWrite: { writeToCache: true },
                        adapter: { ok: true, durationMs },
                        ...(adapterExplain !== undefined ? { adapterRemoteExplain: adapterExplain } : {})
                    })
                } catch (error) {
                    adapter.onError?.(error as Error, 'findMany')
                    const err = error instanceof Error ? error : new Error(String(error))
                    return withExplain(
                        { data: (localResult as any).data },
                        { errors: [{ kind: 'adapter', code: 'FIND_MANY_FAILED', message: err.message, traceId }] }
                    )
                }
            }

            try {
                // Only pass adapter-level filter when a predicate is provided; structured where objects are handled locally
                const adapterFilter = typeof options?.where === 'function' ? options.where : undefined

                let remote = await adapter.getAll(adapterFilter as any)
                remote = remote.map(item => transform(item))

                if (effectiveSkipStore) {
                    // Check if there is local filter logic to apply since we bypassed memory cache
                    if (options?.where && typeof options.where !== 'function') {
                        // Apply purely local query logic on the transient data
                        // Note: This matches the "localResult" behavior but on remote data
                        const opts = { ...options, limit: undefined, offset: undefined } // Apply limit/offset manually if needed or assume query does it?
                        // For now, let's just return the raw remote data as "transient" usually implies 
                        // the backend did the heavy lifting, or we do basic filtering.
                        // But to be consistent with "findMany" contract, we should probably apply the query?
                        // Let's assume adapter.getAll returned everything and we need to filter if it wasn't a smart adapter.
                        // But typically getAll implies "smart" filter wasn't used. 
                        // Let's apply applyQuery just in case.
                        emit('query:cacheWrite', {
                            writeToCache: false,
                            reason: options?.skipStore ? 'skipStore' : 'sparseFields',
                            params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields }
                        })
                        return withExplain(
                            { data: applyQuery(remote as any, options, { matcher }) as T[] },
                            { cacheWrite: { writeToCache: false, reason: options?.skipStore ? 'skipStore' : 'sparseFields' } }
                        )
                    }
                    emit('query:cacheWrite', {
                        writeToCache: false,
                        reason: options?.skipStore ? 'skipStore' : 'sparseFields',
                        params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields }
                    })
                    return withExplain(
                        { data: remote },
                        { cacheWrite: { writeToCache: false, reason: options?.skipStore ? 'skipStore' : 'sparseFields' } }
                    )
                }

                // If storing, maintain references
                remote = remote.map(item => preserveReference(item))

                const existingMap = jotaiStore.get(atom)
                const incomingIds = new Set(remote.map(item => (item as any).id as StoreKey))
                const toRemove: StoreKey[] = []
                existingMap.forEach((_value: T, id: StoreKey) => {
                    if (!incomingIds.has(id)) toRemove.push(id)
                })

                const withRemovals = BaseStore.bulkRemove(toRemove, existingMap)
                const next = BaseStore.bulkAdd(remote as PartialWithId<T>[], withRemovals)
                jotaiStore.set(atom, next)
                if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, existingMap, next)
                bumpAtomVersion(atom, undefined, context)
                emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })
                return withExplain(
                    { data: evaluateWithIndexes(jotaiStore.get(atom), options) },
                    { cacheWrite: { writeToCache: true } }
                )
            } catch (error) {
                adapter.onError?.(error as Error, 'findMany')
                return localResult
            }
        }
    }

    ;(store as any)._matcher = matcher

    return store
}
