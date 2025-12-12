import { PrimitiveAtom } from 'jotai'
import { BaseStore, bumpAtomVersion, globalStore } from './BaseStore'
import { applyQuery } from './query'
import { IndexManager } from './indexes/IndexManager'
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
    const isOptimisticMode = (config?.context?.queueConfig.mode ?? 'optimistic') === 'optimistic'

    let batchGetOneTaskQueue: GetOneTask[] = []
    let batchFetchOneTaskQueue: GetOneTask[] = []
    const indexManager = config?.indexes && config.indexes.length ? new IndexManager<T>(config.indexes) : null

    const indexSnapshotRegister = () => {
        if (!indexManager) return undefined
        const name = config?.storeName || 'store'
        const snapshot = () => {
            const statsMap = indexManager.getAllStats()
            const list: any[] = []
            statsMap.forEach((stats, field) => {
                list.push({
                    field,
                    type: config?.indexes?.find(i => i.field === field)?.type,
                    size: stats?.totalDocs,
                    distinctValues: stats?.distinctValues,
                    avgSetSize: stats?.avgSetSize,
                    maxSetSize: stats?.maxSetSize,
                    minSetSize: stats?.minSetSize
                })
            })
            return list
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
            jotaiStore.set(atom, BaseStore.bulkAdd(items as PartialWithId<T>[], jotaiStore.get(atom)))
            items.forEach(item => indexManager?.add(item))
            bumpAtomVersion(atom, undefined, config?.context)
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
                    // 乐观模式下先同步索引，失败再回滚
                    if (indexManager && isOptimisticMode) {
                        indexManager.add(validObj as any)
                    }

                    BaseStore.dispatch<T>({
                        type: 'add',
                        data: validObj as PartialWithId<T>,
                        adapter,
                        atom,
                        store: jotaiStore,
                        context: config?.context,
                        onSuccess: async o => {
                            await runAfterSave(validObj, 'add')
                            if (indexManager && !isOptimisticMode) {
                                indexManager.add(validObj as any)
                            }
                            resolve(o)
                        },
                        onFail: (error) => {
                            // Rollback index add if已乐观添加
                            if (indexManager && isOptimisticMode) {
                                indexManager.remove(validObj as any)
                            }
                            reject(error || new Error(`Failed to add item with id ${(validObj as any).id}`))
                        }
                    })
                }).catch(reject)
            })
        },

        deleteOneById: (id, options) => {
            return new Promise((resolve, reject) => {
                const oldItem = jotaiStore.get(atom).get(id)
                // 乐观模式下先把索引移除，失败再恢复
                if (indexManager && isOptimisticMode && oldItem) {
                    indexManager.remove(oldItem as any)
                }

                BaseStore.dispatch({
                    type: options?.force ? 'forceRemove' : 'remove',
                    data: { id } as PartialWithId<T>,
                    adapter,
                    atom,
                    store: jotaiStore,
                    context: config?.context,
                    onSuccess: () => {
                        if (indexManager && !isOptimisticMode) {
                            indexManager.remove(oldItem as any)
                        }
                        resolve(true)
                    },
                    onFail: (error) => {
                        // Rollback index removal (仅当之前乐观删过)
                        if (indexManager && isOptimisticMode && oldItem) {
                            indexManager.add(oldItem as any)
                        }
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

            // Maintain indexes incrementally
            if (indexManager) {
                toRemove.forEach(id => {
                    const old = existingMap.get(id)
                    if (old) indexManager.remove(old as any)
                })
                itemsToCache.forEach(item => indexManager.add(item as any))
            }

            bumpAtomVersion(atom, undefined, config?.context)

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
                    jotaiStore.set(atom, BaseStore.bulkAdd(fetched as PartialWithId<T>[], jotaiStore.get(atom)))
                    fetched.forEach(item => indexManager?.add(item))
                    bumpAtomVersion(atom, undefined, config?.context)
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
                        // 乐观模式：先替换索引，失败回滚
                        if (indexManager && isOptimisticMode) {
                            indexManager.remove(base as any)
                            indexManager.add(validObj as any)
                        }

                        BaseStore.dispatch({
                            type: 'update',
                            atom,
                            adapter,
                            data: validObj,
                            store: jotaiStore,
                            context: config?.context,
                            onSuccess: async updated => {
                                await runAfterSave(validObj, 'update')
                                if (indexManager && !isOptimisticMode) {
                                    indexManager.remove(base as any)
                                    indexManager.add(validObj as any)
                                }
                                resolve(updated)
                            },
                            onFail: (error) => {
                                // Rollback index changes (仅当乐观已修改)
                                if (indexManager && isOptimisticMode) {
                                    indexManager.remove(validObj as any)
                                    indexManager.add(base as any)
                                }
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
                                    jotaiStore.set(atom, BaseStore.add(validFetched as PartialWithId<T>, jotaiStore.get(atom)))
                                    indexManager?.add(validFetched as any)
                                    bumpAtomVersion(atom, undefined, config?.context)

                                    const prepare = async () => {
                                        const base = validFetched as unknown as PartialWithId<T>
                                        let merged = Object.assign({}, base, obj, { updatedAt: Date.now(), createdAt: (base as any).createdAt ?? Date.now(), id: obj.id }) as PartialWithId<T>
                                        merged = await runBeforeSave(merged, 'update')
                                        merged = transform(merged as T) as unknown as PartialWithId<T>
                                        merged = await validateWithSchema(merged as T, config?.schema) as unknown as PartialWithId<T>
                                        return { merged, base }
                                    }

                                    prepare().then(({ merged: validObj, base }) => {
                                        if (indexManager && isOptimisticMode) {
                                            indexManager.remove(base as any)
                                            indexManager.add(validObj as any)
                                        }

                                        BaseStore.dispatch({
                                            type: 'update',
                                            data: validObj,
                                            atom,
                                            adapter,
                                            store: jotaiStore,
                                            context: config?.context,
                                            onSuccess: async updated => {
                                                await runAfterSave(validObj, 'update')
                                                if (indexManager && !isOptimisticMode) {
                                                    indexManager.remove(base as any)
                                                    indexManager.add(validObj as any)
                                                }
                                                resolve(updated)
                                            },
                                            onFail: (error) => {
                                                if (indexManager && isOptimisticMode) {
                                                    indexManager.remove(validObj as any)
                                                    indexManager.add(base as any)
                                                }
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
                const candidateIds = indexManager?.collectCandidates(opts?.where)
                const singleOrder = opts?.orderBy && !Array.isArray(opts.orderBy) ? opts.orderBy : undefined
                const hasFullCoverage = !!(indexManager && indexManager.coversWhere(opts?.where))
                const orderedIds = indexManager?.getOrderedCandidates(singleOrder, candidateIds, {
                    limit: opts?.limit,
                    offset: opts?.offset,
                    applyLimit: hasFullCoverage
                })
                const appliedLimitInIndex = Boolean(orderedIds && hasFullCoverage && opts?.limit !== undefined)
                const queryOptions = appliedLimitInIndex ? { ...opts, limit: undefined, offset: undefined } : opts
                const preSorted = Boolean(orderedIds)
                const source = orderedIds
                    ? orderedIds.map(id => mapRef.get(id) as T).filter(Boolean)
                    : candidateIds
                        ? Array.from(candidateIds).map(id => mapRef.get(id) as T).filter(Boolean)
                        : Array.from(mapRef.values()) as T[]
                return applyQuery(source as any, queryOptions, { preSorted }) as T[]
            }

            // Compute from current cache for即时 UI
            const map = jotaiStore.get(atom)
            const localResult = evaluateWithIndexes(map, options)

            // Prefer adapter-level findMany when可用（支持远程过滤/分页）
            if (typeof (adapter as any).findMany === 'function') {
                try {
                    const raw = await (adapter as any).findMany(options)
                    const { data, pageInfo } = Array.isArray(raw)
                        ? { data: raw }
                        : { data: raw?.data ?? [], pageInfo: raw?.pageInfo }

                    const transformed = (data || []).map((item: T) => transform(item))

                    if (options?.skipStore) {
                        return Array.isArray(raw) ? transformed : { data: transformed, pageInfo }
                    }

                    const existingMap = jotaiStore.get(atom)
                    const next = new Map(existingMap)
                    // Apply referential equality check only if we are using the store
                    const processed = transformed.map((item: T) => preserveReference(item))

                    processed.forEach((item: T) => {
                        const id = (item as any).id as StoreKey
                        const prev = existingMap.get(id)
                        if (indexManager && prev) indexManager.remove(prev as any)
                        next.set(id, item)
                        if (indexManager) indexManager.add(item as any)
                    })

                    jotaiStore.set(atom, next)
                    bumpAtomVersion(atom, undefined, config?.context)

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

                if (options?.skipStore) {
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
                        return applyQuery(remote as any, options) as T[]
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

                if (indexManager) {
                    toRemove.forEach(id => {
                        const old = existingMap.get(id)
                        if (old) indexManager.remove(old as any)
                    })
                    remote.forEach(item => indexManager.add(item as any))
                }

                bumpAtomVersion(atom, undefined, config?.context)
                return evaluateWithIndexes(jotaiStore.get(atom), options)
            } catch (error) {
                adapter.onError?.(error as Error, 'findMany')
                return localResult
            }
        }
    }

    return store
}
