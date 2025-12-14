import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreKey } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import type { StoreRuntime } from './runtime'

type GetOneTask<T> = {
    id: StoreKey
    resolve: (value: T | undefined) => void
}

export function createBatchGet<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, transform, context, indexManager } = runtime

    let batchGetOneTaskQueue: GetOneTask<T>[] = []
    let batchFetchOneTaskQueue: GetOneTask<T>[] = []

    const processGetOneTaskQueue = async () => {
        if (!batchGetOneTaskQueue.length) return

        const sliced = batchGetOneTaskQueue.slice()
        batchGetOneTaskQueue = []

        const ids = Array.from(new Set(sliced.map(i => i.id)).values())
        let items = (await adapter.bulkGet(ids)).filter((i): i is T => i !== undefined)
        items = items.map(transform)

        const idToItem = Object.fromEntries(items.map(i => [(i as any).id, i]))
        sliced.forEach(task => {
            task.resolve(idToItem[task.id])
        })

        const before = jotaiStore.get(atom)
        const after = BaseStore.bulkAdd(items as PartialWithId<T>[], before)
        commitAtomMapUpdate({ jotaiStore, atom, before, after, context, indexManager })
    }

    const processFetchOneTaskQueue = async () => {
        if (!batchFetchOneTaskQueue.length) return

        const sliced = batchFetchOneTaskQueue.slice()
        batchFetchOneTaskQueue = []

        const ids = Array.from(new Set(sliced.map(i => i.id)).values())
        let items = (await adapter.bulkGet(ids)).filter((i): i is T => i !== undefined)
        items = items.map(transform)

        const idToItem = Object.fromEntries(items.map(i => [(i as any).id, i]))
        sliced.forEach(task => {
            task.resolve(idToItem[task.id])
        })
    }

    const handleGetOne = (id: StoreKey, resolve: (v: T | undefined) => void) => {
        if (batchGetOneTaskQueue.length) {
            batchGetOneTaskQueue.push({ resolve, id })
        } else {
            batchGetOneTaskQueue = [{ resolve, id }]
            Promise.resolve().then(() => {
                processGetOneTaskQueue()
            })
        }
    }

    const handleFetchOne = (id: StoreKey, resolve: (v: T | undefined) => void) => {
        if (batchFetchOneTaskQueue.length) {
            batchFetchOneTaskQueue.push({ resolve, id })
        } else {
            batchFetchOneTaskQueue = [{ resolve, id }]
            Promise.resolve().then(() => {
                processFetchOneTaskQueue()
            })
        }
    }

    return {
        getOneById: (id: StoreKey) => {
            return new Promise<T | undefined>(resolve => {
                const atomOne = jotaiStore.get(atom).get(id)
                if (atomOne) {
                    resolve(atomOne)
                } else {
                    handleGetOne(id, resolve)
                }
            })
        },
        fetchOneById: (id: StoreKey) => {
            return new Promise<T | undefined>(resolve => {
                handleFetchOne(id, resolve)
            })
        }
    }
}
