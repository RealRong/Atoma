import { PrimitiveAtom } from 'jotai'
import { BaseStore, bumpAtomVersion, globalStore } from './BaseStore'
import { applyQuery } from './query'
import { IndexManager } from './indexes/IndexManager'
import { IndexSynchronizer } from './indexes/IndexSynchronizer'
import { createStoreContext } from './StoreContext'
import type { QueryMatcherOptions } from './query/QueryMatcher'
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

            const evaluateWithIndexes = (mapRef: Map<StoreKey, T>, opts?: FindManyOptions<T>) => {
                const candidateRes = indexManager ? indexManager.collectCandidates(opts?.where) : { kind: 'unsupported' as const }
                if (candidateRes.kind === 'empty') return [] as T[]
                const source =
                    candidateRes.kind === 'candidates'
                        ? Array.from(candidateRes.ids).map(id => mapRef.get(id) as T).filter(Boolean)
                        : Array.from(mapRef.values()) as T[]
                return applyQuery(source as any, opts, { preSorted: false, matcher }) as T[]
            }

            // Compute from current cache for即时 UI
            const map = jotaiStore.get(atom)
            const localResult = evaluateWithIndexes(map, options)
            const effectiveSkipStore = Boolean(options?.skipStore || (options as any)?.fields?.length)

            // Prefer adapter-level findMany when可用（支持远程过滤/分页）
            if (typeof (adapter as any).findMany === 'function') {
                try {
                    const raw = await (adapter as any).findMany(options)
                    const { data, pageInfo } = Array.isArray(raw)
                        ? { data: raw }
                        : { data: raw?.data ?? [], pageInfo: raw?.pageInfo }

                    const transformed = (data || []).map((item: T) => transform(item))

                    if (effectiveSkipStore) {
                        return Array.isArray(raw) ? transformed : { data: transformed, pageInfo }
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

                    return Array.isArray(raw) ? transformed : { data: transformed, pageInfo }
                } catch (error) {
                    adapter.onError?.(error as Error, 'findMany')
                    return localResult
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
                        return applyQuery(remote as any, options, { matcher }) as T[]
                    }
                    return remote
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
                return evaluateWithIndexes(jotaiStore.get(atom), options)
            } catch (error) {
                adapter.onError?.(error as Error, 'findMany')
                return localResult
            }
        }
    }

    ;(store as any)._matcher = matcher

    return store
}
