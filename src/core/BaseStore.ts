import { enableMapSet, enablePatches, produce } from 'immer'
import { PrimitiveAtom, createStore } from 'jotai'
import { orderBy } from 'lodash'
import {
    IBase,
    PartialWithId,
    StoreDispatchEvent,
    QueueConfig,
    StoreKey
} from './types'
import { getIdGenerator } from './idGenerator'
import { StoreContext, createStoreContext } from './StoreContext'
import { HistoryCallback } from './history/HistoryRecorder'

// Enable Map/Set drafting for Immer (required for Map-based atom state)
enableMapSet()
// Enable patch generation for history/adapter sync
enablePatches()

/**
 * Global Jotai store for managing atoms
 */
export const globalStore = createStore()

/**
 * Default global context for backward compatibility
 * @deprecated Use per-store context via createSyncStore instead
 */
const defaultGlobalContext = createStoreContext()

export const getVersionSnapshot = (
    atom: PrimitiveAtom<Map<any, any>>,
    fields?: string[],
    context?: StoreContext
): number => {
    const ctx = context || defaultGlobalContext
    return ctx.versionTracker.getSnapshot(atom, fields)
}

/** Bump version counters for an atom; use empty set to bump全局 */
export const bumpAtomVersion = (
    atom: PrimitiveAtom<Map<any, any>>,
    fields?: Set<string>,
    context?: StoreContext
) => {
    const ctx = context || defaultGlobalContext
    ctx.versionTracker.bump(atom, fields ?? new Set())
}

/**
 * Set the history callback for undo/redo support
 * @deprecated Use per-store context instead
 */
export function setHistoryCallback(callback: HistoryCallback) {
    defaultGlobalContext.historyRecorder.setCallback(callback)
}

/**
 * Process queued operations (support external queue map for direct writes)
 */
const handleQueue = (
    contextOrQueueMap?: StoreContext | Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>,
    queueMap?: Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>
) => {
    // Determine context and queue map from parameters
    let context: StoreContext
    let atomQueues: Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>

    if (contextOrQueueMap instanceof Map) {
        // Called with (queueMap)
        context = defaultGlobalContext
        atomQueues = contextOrQueueMap
    } else if (contextOrQueueMap && queueMap) {
        // Called with (context, queueMap)
        context = contextOrQueueMap
        atomQueues = queueMap
    } else if (contextOrQueueMap) {
        // Called with (context)
        context = contextOrQueueMap
        atomQueues = context.queueManager.flush()
    } else {
        // Called with ()
        context = defaultGlobalContext
        atomQueues = context.queueManager.flush()
    }

    const mode = context.queueConfig.mode || 'optimistic'

    Array.from(atomQueues.entries()).forEach(([atom, operations]) => {
        // Use context from first operation if available, otherwise use passed context
        const eventContext = operations[0]?.context || context
        const store = operations[0]?.store || globalStore
        const { adapter } = operations[0]
        const applyResult = eventContext.operationApplier.apply(operations, store.get(atom))

        // Map callbacks to payloads (if any)
        const callbacks = operations.map((op, idx) => {
            const payload = applyResult.appliedData[idx]
            return {
                onSuccess: () => {
                    if (op.type === 'add' || op.type === 'update') {
                        return op.onSuccess?.(payload ?? (op.data as any))
                    }
                    return op.onSuccess?.()
                },
                onFail: op.onFail
            }
        })

        eventContext.adapterSync.syncAtom({
            adapter,
            applyResult,
            atom,
            callbacks,
            store,
            versionTracker: eventContext.versionTracker,
            historyRecorder: eventContext.historyRecorder,
            mode
        })
    })
}

/**
 * BaseStore - Core CRUD operations on atom Maps
 */
export const BaseStore = {
    /**
     * Clear all items from map
     */
    clear<T>(data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.clear()
        })
    },

    /**
     * Add single item to map
     */
    add<T>(item: PartialWithId<T>, data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.set(item.id, item as any)
        })
    },

    /**
     * Update single item in map
     */
    update<T>(item: PartialWithId<T>, data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.set(item.id, item as any)
        })
    },

    /**
     * Bulk add items to map
     */
    bulkAdd<T>(items: PartialWithId<T>[], data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            items.forEach(i => draft.set(i.id, i as any))
        })
    },

    /**
     * Bulk remove items from map
     */
    bulkRemove<T>(ids: StoreKey[], data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            ids.forEach(id => draft.delete(id))
        })
    },

    /**
     * Dispatch an operation to the queue for batched processing
     */
    dispatch<T extends import('./types').Entity>(event: StoreDispatchEvent<T>) {
        const context = event.context || defaultGlobalContext

        if (!context.queueConfig.enabled) {
            const directQueue = new Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>()
            directQueue.set(event.atom, [event])
            handleQueue(context, directQueue)
            return
        }

        context.queueManager.enqueue(event)
        Promise.resolve().then(() => handleQueue(context))
    },

    /**
     * Remove single item from map
     */
    remove<T>(id: StoreKey, data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.delete(id)
        })
    },

    /**
     * Get item by ID
     */
    get<T>(id: StoreKey | undefined, data: Map<StoreKey, T>): T | undefined {
        if (id !== undefined && id !== null) {
            return data.get(id)
        }
    },

    /**
     * Get all items sorted by creation date
     */
    orderedData<T extends IBase>(data: Map<StoreKey, T>): T[] {
        return orderBy(Array.from(data.values()), 'createdAt', 'desc')
    },

    /**
     * Sort array by creation date
     */
    orderedArray<T extends IBase>(data: T[]): T[] {
        return data.sort((a, b) => b.createdAt - a.createdAt)
    },

    /**
     * Initialize base object with timestamps and ID
     */
    initBaseObject<T extends Partial<IBase>>(obj: T, idGenerator?: () => StoreKey): PartialWithId<T> {
        const generator = idGenerator || getIdGenerator()
        return {
            ...obj,
            id: obj.id || generator(),
            updatedAt: Date.now(),
            createdAt: Date.now()
        } as PartialWithId<T>
    }
}



export default BaseStore

/**
 * Export createStoreContext for use in createSyncStore
 */
export { createStoreContext } from './StoreContext'
export type { StoreContext } from './StoreContext'
