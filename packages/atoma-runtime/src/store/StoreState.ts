import { applyWritebackToMap, preserveReferenceShallow } from 'atoma-core/store'
import type { Entity, QueryMatcherOptions, StoreIndexesLike, StoreWritebackArgs } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreChangedIds, StoreSnapshot, StoreState } from 'atoma-types/runtime'

export class SimpleStoreState<T extends Entity = any> implements StoreState<T> {
    private snapshot: StoreSnapshot<T>
    private listeners = new Set<() => void>()
    readonly indexes: StoreIndexesLike<T> | null
    readonly matcher?: QueryMatcherOptions

    constructor(args?: { initial?: StoreSnapshot<T>; indexes?: StoreIndexesLike<T> | null; matcher?: QueryMatcherOptions }) {
        this.snapshot = args?.initial ?? new Map<EntityId, T>()
        this.indexes = args?.indexes ?? null
        this.matcher = args?.matcher
    }

    getSnapshot = () => this.snapshot

    setSnapshot = (next: StoreSnapshot<T>) => {
        this.snapshot = next
        this.listeners.forEach(listener => {
            try {
                listener()
            } catch {
                // ignore
            }
        })
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    commit = (params: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds?: StoreChangedIds
    }) => {
        const { before, after, changedIds } = params
        const indexes = this.indexes

        if (before === after) return

        if (changedIds) {
            const size = Array.isArray(changedIds)
                ? changedIds.length
                : (changedIds as ReadonlySet<EntityId>).size
            if (size === 0) return
        }

        this.setSnapshot(after)
        if (changedIds) {
            indexes?.applyChangedIds(before, after, changedIds)
        } else {
            indexes?.applyMapDiff(before, after)
        }
    }

    applyWriteback = (args: StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => {
        const before = this.snapshot as Map<EntityId, T>
        const preserve = options?.preserve ?? preserveReferenceShallow
        const result = applyWritebackToMap(before, args, { preserve })
        if (!result) return

        this.commit({
            before: result.before,
            after: result.after,
            changedIds: result.changedIds
        })
    }
}
