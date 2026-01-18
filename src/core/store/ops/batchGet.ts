import type { CoreRuntime, Entity, PartialWithId, StoreReadOptions } from '../../types'
import type { EntityId } from '#protocol'
import { bulkAdd, commitAtomMapUpdateDelta } from '../internals/atomMap'
import { resolveObservabilityContext } from '../internals/runtime'
import type { ObservabilityContext } from '#observability'
import { executeQuery } from '../../ops/opsExecutor'
import type { StoreHandle } from '../internals/handleTypes'

type GetOneTask<T> = {
    id: EntityId
    resolve: (value: T | undefined) => void
    reject: (error: unknown) => void
    observabilityContext: ObservabilityContext
}

type TaskGroup<T> = {
    observabilityContext: ObservabilityContext
    tasks: GetOneTask<T>[]
}

const NO_TRACE = '__no_trace__'

const groupTasksByTrace = <T>(tasks: GetOneTask<T>[]): TaskGroup<T>[] => {
    if (tasks.length <= 1) {
        const only = tasks[0]
        return only ? [{ observabilityContext: only.observabilityContext, tasks: [only] }] : []
    }

    const firstTraceId = tasks[0].observabilityContext.traceId
    if (firstTraceId === undefined) {
        let allNoTrace = true
        for (let i = 1; i < tasks.length; i++) {
            if (tasks[i].observabilityContext.traceId !== undefined) {
                allNoTrace = false
                break
            }
        }
        if (allNoTrace) {
            return [{ observabilityContext: tasks[0].observabilityContext, tasks }]
        }
    }

    const byTrace = new Map<string, TaskGroup<T>>()

    for (const task of tasks) {
        const key = task.observabilityContext.traceId ?? NO_TRACE
        const existing = byTrace.get(key)
        if (existing) {
            existing.tasks.push(task)
            continue
        }
        byTrace.set(key, { observabilityContext: task.observabilityContext, tasks: [task] })
    }

    return Array.from(byTrace.values())
}

const dedupeTaskIds = <T>(tasks: GetOneTask<T>[]): EntityId[] => {
    const ids: EntityId[] = []
    const seen = new Set<EntityId>()
    for (const task of tasks) {
        if (seen.has(task.id)) continue
        seen.add(task.id)
        ids.push(task.id)
    }
    return ids
}

export function createBatchGet<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom, transform } = handle

    let batchGetOneTaskQueue: GetOneTask<T>[] = []
    let batchFetchOneTaskQueue: GetOneTask<T>[] = []

    const processGetOneTaskQueue = () => {
        if (!batchGetOneTaskQueue.length) return

        const sliced = batchGetOneTaskQueue
        batchGetOneTaskQueue = []

        const groups = groupTasksByTrace<T>(sliced)

        const processGroup = async (group: TaskGroup<T>) => {
            const ids = dedupeTaskIds(group.tasks)

            try {
                const { data } = await executeQuery(clientRuntime, handle, { where: { id: { in: ids } } } as any, group.observabilityContext)

                const idToItem = new Map<EntityId, T>()
                const itemsToCache: T[] = []

                for (const got of data) {
                    if (got === undefined) continue
                    const item = transform(got as T)
                    const id = (item as any).id as EntityId
                    idToItem.set(id, item)
                    itemsToCache.push(item)
                }

                const before = jotaiStore.get(atom)
                const after = itemsToCache.length
                    ? bulkAdd(itemsToCache as PartialWithId<T>[], before)
                    : before

                if (before !== after && itemsToCache.length) {
                    const changedIds = new Set<EntityId>()
                    for (const item of itemsToCache) {
                        const id = (item as any).id as EntityId
                        if (before.get(id) !== item) changedIds.add(id)
                    }
                    commitAtomMapUpdateDelta({ handle, before, after, changedIds })
                }

                const currentMap = after
                for (const task of group.tasks) {
                    task.resolve(idToItem.get(task.id) ?? currentMap.get(task.id))
                }
            } catch (error) {
                for (const task of group.tasks) {
                    task.reject(error)
                }
            }
        }

        if (groups.length === 1) {
            void processGroup(groups[0])
            return
        }

        void Promise.allSettled(groups.map(processGroup))
    }

    const processFetchOneTaskQueue = () => {
        if (!batchFetchOneTaskQueue.length) return

        const sliced = batchFetchOneTaskQueue
        batchFetchOneTaskQueue = []

        const groups = groupTasksByTrace<T>(sliced)

        const processGroup = async (group: TaskGroup<T>) => {
            const ids = dedupeTaskIds(group.tasks)
            try {
                const { data } = await executeQuery(clientRuntime, handle, { where: { id: { in: ids } } } as any, group.observabilityContext)

                const idToItem = new Map<EntityId, T>()
                for (const got of data) {
                    if (got === undefined) continue
                    const item = transform(got as T)
                    const id = (item as any).id as EntityId
                    idToItem.set(id, item)
                }

                for (const task of group.tasks) {
                    task.resolve(idToItem.get(task.id))
                }
            } catch (error) {
                for (const task of group.tasks) {
                    task.reject(error)
                }
            }
        }

        if (groups.length === 1) {
            void processGroup(groups[0])
            return
        }

        void Promise.allSettled(groups.map(processGroup))
    }


    const handleGetOne = (
        id: EntityId,
        resolve: (v: T | undefined) => void,
        reject: (error: unknown) => void,
        options?: StoreReadOptions
    ) => {
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)
        if (batchGetOneTaskQueue.length) {
            batchGetOneTaskQueue.push({ resolve, reject, id, observabilityContext })
        } else {
            batchGetOneTaskQueue = [{ resolve, reject, id, observabilityContext }]
            Promise.resolve().then(() => {
                processGetOneTaskQueue()
            })
        }
    }

    const handleFetchOne = (
        id: EntityId,
        resolve: (v: T | undefined) => void,
        reject: (error: unknown) => void,
        options?: StoreReadOptions
    ) => {
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)
        if (batchFetchOneTaskQueue.length) {
            batchFetchOneTaskQueue.push({ resolve, reject, id, observabilityContext })
        } else {
            batchFetchOneTaskQueue = [{ resolve, reject, id, observabilityContext }]
            Promise.resolve().then(() => {
                processFetchOneTaskQueue()
            })
        }
    }

    return {
        getOne: (id: EntityId, options?: StoreReadOptions) => {
            return new Promise<T | undefined>((resolve, reject) => {
                const atomOne = jotaiStore.get(atom).get(id)
                if (atomOne !== undefined) {
                    resolve(atomOne)
                    return
                }
                handleGetOne(id, resolve, reject, options)
            })
        },
        fetchOne: (id: EntityId, options?: StoreReadOptions) => {
            return new Promise<T | undefined>((resolve, reject) => {
                handleFetchOne(id, resolve, reject, options)
            })
        }
    }
}
