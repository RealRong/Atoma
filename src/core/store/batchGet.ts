import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreKey, StoreReadOptions } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import { type StoreRuntime, resolveInternalOperationContext } from './runtime'
import type { InternalOperationContext } from '../../observability/types'

type GetOneTask<T> = {
    id: StoreKey
    resolve: (value: T | undefined) => void
    internalContext?: InternalOperationContext
}

export function createBatchGet<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, transform, context, indexManager, storeName, resolveOperationTraceId } = runtime

    let batchGetOneTaskQueue: GetOneTask<T>[] = []
    let batchFetchOneTaskQueue: GetOneTask<T>[] = []

    const processGetOneTaskQueue = async () => {
        if (!batchGetOneTaskQueue.length) return

        const sliced = batchGetOneTaskQueue.slice()
        batchGetOneTaskQueue = []

        const groups = (() => {
            const byTrace = new Map<string, { internalContext?: InternalOperationContext; tasks: GetOneTask<T>[] }>()
            const NO_TRACE = '__no_trace__'

            sliced.forEach(task => {
                const key = task.internalContext?.traceId ?? NO_TRACE
                const cur = byTrace.get(key)
                if (cur) {
                    cur.tasks.push(task)
                    return
                }
                byTrace.set(key, { internalContext: task.internalContext, tasks: [task] })
            })

            return Array.from(byTrace.values())
        })()

        const items: T[] = []
        const idToItem = new Map<StoreKey, T>()

        for (const group of groups) {
            const ids = Array.from(new Set(group.tasks.map(i => i.id)).values())
            let fetched = (await adapter.bulkGet(ids, group.internalContext)).filter((i): i is T => i !== undefined)
            fetched = fetched.map(transform)

            fetched.forEach(item => {
                const id = (item as any).id as StoreKey
                idToItem.set(id, item)
                items.push(item)
            })

            group.tasks.forEach(task => {
                task.resolve(idToItem.get(task.id))
            })
        }

        const before = jotaiStore.get(atom)
        const after = BaseStore.bulkAdd(items as PartialWithId<T>[], before)
        commitAtomMapUpdate({ jotaiStore, atom, before, after, context, indexManager })
    }

    const processFetchOneTaskQueue = async () => {
        if (!batchFetchOneTaskQueue.length) return

        const sliced = batchFetchOneTaskQueue.slice()
        batchFetchOneTaskQueue = []

        const groups = (() => {
            const byTrace = new Map<string, { internalContext?: InternalOperationContext; tasks: GetOneTask<T>[] }>()
            const NO_TRACE = '__no_trace__'

            sliced.forEach(task => {
                const key = task.internalContext?.traceId ?? NO_TRACE
                const cur = byTrace.get(key)
                if (cur) {
                    cur.tasks.push(task)
                    return
                }
                byTrace.set(key, { internalContext: task.internalContext, tasks: [task] })
            })

            return Array.from(byTrace.values())
        })()

        const idToItem = new Map<StoreKey, T>()

        for (const group of groups) {
            const ids = Array.from(new Set(group.tasks.map(i => i.id)).values())
            let items = (await adapter.bulkGet(ids, group.internalContext)).filter((i): i is T => i !== undefined)
            items = items.map(transform)

            items.forEach(item => {
                const id = (item as any).id as StoreKey
                idToItem.set(id, item)
            })

            group.tasks.forEach(task => {
                task.resolve(idToItem.get(task.id))
            })
        }
    }


    const handleGetOne = (id: StoreKey, resolve: (v: T | undefined) => void, options?: StoreReadOptions) => {
        const internalContext = resolveInternalOperationContext(runtime, options)
        if (batchGetOneTaskQueue.length) {
            batchGetOneTaskQueue.push({ resolve, id, internalContext })
        } else {
            batchGetOneTaskQueue = [{ resolve, id, internalContext }]
            Promise.resolve().then(() => {
                processGetOneTaskQueue()
            })
        }
    }

    const handleFetchOne = (id: StoreKey, resolve: (v: T | undefined) => void, options?: StoreReadOptions) => {
        const internalContext = resolveInternalOperationContext(runtime, options)
        if (batchFetchOneTaskQueue.length) {
            batchFetchOneTaskQueue.push({ resolve, id, internalContext })
        } else {
            batchFetchOneTaskQueue = [{ resolve, id, internalContext }]
            Promise.resolve().then(() => {
                processFetchOneTaskQueue()
            })
        }
    }

    return {
        getOneById: (id: StoreKey, options?: StoreReadOptions) => {
            return new Promise<T | undefined>(resolve => {
                const atomOne = jotaiStore.get(atom).get(id)
                if (atomOne) {
                    resolve(atomOne)
                } else {
                    handleGetOne(id, resolve, options)
                }
            })
        },
        fetchOneById: (id: StoreKey, options?: StoreReadOptions) => {
            return new Promise<T | undefined>(resolve => {
                handleFetchOne(id, resolve, options)
            })
        }
    }
}
