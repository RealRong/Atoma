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
import { AtomVersionTracker } from './state/AtomVersionTracker'
import { QueueManager } from './state/QueueManager'
import { OperationApplier } from './ops/OperationApplier'
import { AdapterSync } from './ops/AdapterSync'
import { HistoryRecorder, HistoryCallback } from './history/HistoryRecorder'

// Enable Map/Set drafting for Immer (required for Map-based atom state)
enableMapSet()
// Enable patch generation for history/adapter sync
enablePatches()

/**
 * Global Jotai store for managing atoms
 */
export const globalStore = createStore()

// Singletons for core services
const versionTracker = new AtomVersionTracker()
const queueManager = new QueueManager()
const historyRecorder = new HistoryRecorder()
const operationApplier = new OperationApplier()
const adapterSync = new AdapterSync()

export const getVersionSnapshot = (atom: PrimitiveAtom<Map<any, any>>, fields?: string[]): number => {
    return versionTracker.getSnapshot(atom, fields)
}

/** Bump version counters for an atom; use empty set to bump全局 */
export const bumpAtomVersion = (atom: PrimitiveAtom<Map<any, any>>, fields?: Set<string>) => {
    versionTracker.bump(atom, fields ?? new Set())
}

/**
 * Set the history callback for undo/redo support
 */
export function setHistoryCallback(callback: HistoryCallback) {
    historyRecorder.setCallback(callback)
}

/**
 * Process queued operations (support external queue map for direct writes)
 */
const handleQueue = (queueMap?: Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>) => {
    const mode = queueConfig.mode || 'optimistic'
    const atomQueues = queueMap ?? queueManager.flush()

    Array.from(atomQueues.entries()).forEach(([atom, operations]) => {
        const store = operations[0]?.store || globalStore
        const { adapter } = operations[0]
        const applyResult = operationApplier.apply(operations, store.get(atom))

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

        adapterSync.syncAtom({
            adapter,
            applyResult,
            atom,
            callbacks,
            store,
            versionTracker,
            historyRecorder,
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
    dispatch<T>(event: StoreDispatchEvent<T>) {
        if (!queueConfig.enabled) {
            const directQueue = new Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>()
            directQueue.set(event.atom, [event])
            handleQueue(directQueue)
            return
        }

        queueManager.enqueue(event)
        Promise.resolve().then(() => handleQueue())
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



/**
 * Queue configuration
 * 
 * @property enabled - Enable batch processing (default: true)
 *   - When `true`: Operations are batched and processed together in microtask
 *   - When `false`: Operations are processed immediately via queue mechanism (synchronous)
 *     Note: This is NOT a direct write bypass. It still uses the queue logic (drafts, callbacks)
 *     but executes synchronously without waiting for microtask.
 * 
 * @property mode - Success/failure mode (default: 'optimistic')
 *   - `'optimistic'`: UI updates immediately, adapter syncs in background
 *     - Pro: Fast UI response
 *     - Con: Need to handle rollback on adapter failure
 *   - `'strict'`: UI updates ONLY after adapter confirms success
 *     - Pro: Guaranteed consistency
 *     - Con: Slower UI response (waits for network/DB)
 * 
 * @property debug - Log queue operations (default: false)
 */
export const queueConfig: QueueConfig = {
    enabled: true,
    debug: false
}

export default BaseStore
