import { enableMapSet, enablePatches, produce } from 'immer'
import { PrimitiveAtom, createStore } from 'jotai/vanilla'
import { orderBy } from 'lodash'
import {
    IBase,
    PartialWithId,
    StoreDispatchEvent,
    QueueConfig,
    StoreKey
} from './types'
import { getIdGenerator } from './idGenerator'
import type { StoreContext } from './StoreContext'
import { normalizeOperationContext } from './operationContext'

// Enable Map/Set drafting for Immer (required for Map-based atom state)
enableMapSet()
// Enable patch generation for history/adapter sync
enablePatches()

/**
 * Global Jotai store for managing atoms
 */
export const globalStore = createStore()

/** Bump version counters for an atom; use empty set to bump global */
export const bumpAtomVersion = (
    atom: PrimitiveAtom<Map<any, any>>,
    fields: Set<string> | undefined,
    context: StoreContext
) => {
    context.versionTracker.bump(atom, fields ?? new Set())
}

/**
 * Process queued operations (support external queue map for direct writes)
 */
const handleQueue = (context: StoreContext, queueMap?: Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>) => {
    const atomQueues = queueMap ?? context.queueManager.flush()

    const mode = context.queueConfig.mode || 'optimistic'

    Array.from(atomQueues.entries()).forEach(([atom, operations]) => {
        const segmentKey = (op: StoreDispatchEvent<any>) => {
            const c = op.opContext
            return `${c?.scope ?? 'default'}|${c?.origin ?? 'user'}|${c?.actionId ?? ''}`
        }

        const segments: StoreDispatchEvent<any>[][] = []
        let current: StoreDispatchEvent<any>[] = []
        let currentKey: string | undefined

        operations.forEach((op) => {
            const key = segmentKey(op)
            if (!current.length) {
                current = [op]
                currentKey = key
                return
            }
            if (key === currentKey) {
                current.push(op)
                return
            }
            segments.push(current)
            current = [op]
            currentKey = key
        })
        if (current.length) segments.push(current)

        segments.forEach((ops) => {
            const eventContext = ops[0].context
            const store = ops[0].store
            const { adapter } = ops[0]
            const applyResult = eventContext.operationApplier.apply(ops, store.get(atom))

            const sharedTraceId = (() => {
                const ids = ops
                    .map(op => op.traceId)
                    .filter((v): v is string => typeof v === 'string' && Boolean(v))
                if (!ids.length) return undefined
                const uniq = new Set(ids)
                return uniq.size === 1 ? ids[0] : undefined
            })()

            const opContext = ops[0].opContext

            // Map callbacks to payloads (if any)
            const callbacks = ops.map((op, idx) => {
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
                operationRecorder: eventContext.operationRecorder,
                indexes: (ops[0] as any).indexes ?? null,
                mode,
                traceId: sharedTraceId,
                debug: eventContext.debug,
                debugSink: eventContext.debugSink,
                storeName: eventContext.storeName,
                opContext
            })
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
        const context = event.context
        const normalized = {
            ...event,
            opContext: normalizeOperationContext(event.opContext, { traceId: event.traceId })
        } as StoreDispatchEvent<T>

        if (!context.queueConfig.enabled) {
            const directQueue = new Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>()
            directQueue.set(normalized.atom, [normalized])
            handleQueue(context, directQueue)
            return
        }

        context.queueManager.enqueue(normalized)
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

export type { StoreContext } from './StoreContext'
