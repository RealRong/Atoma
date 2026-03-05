import type { Entity, Indexes, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { StoreState as StoreStateType } from 'atoma-types/runtime'
import {
    apply,
    replace,
    upsert
} from 'atoma-core/store'

export class StoreState<T extends Entity = Entity> implements StoreStateType<T> {
    private current: ReadonlyMap<EntityId, T>
    private listeners = new Set<() => void>()
    readonly indexes: Indexes<T> | null

    constructor({
        initial,
        indexes
    }: {
        initial?: ReadonlyMap<EntityId, T>
        indexes?: Indexes<T> | null
    }) {
        this.current = initial ?? new Map<EntityId, T>()
        this.indexes = indexes ?? null
    }

    snapshot = () => this.current

    private notifyListeners = () => {
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

    private commit = (
        after: Map<EntityId, T>,
        changes: ReadonlyArray<StoreChange<T>>
    ): ReadonlyArray<StoreChange<T>> => {
        if (!changes.length) return []
        if (!this.indexes && this.listeners.size === 0) {
            this.current = after
            return changes
        }
        this.indexes?.apply(changes)
        this.current = after
        if (this.listeners.size) {
            this.notifyListeners()
        }
        return changes
    }

    apply = (changes: ReadonlyArray<StoreChange<T>>): ReadonlyArray<StoreChange<T>> => {
        const before = this.current as Map<EntityId, T>
        const result = apply({
            before,
            changes
        })
        return this.commit(result.after, result.changes)
    }

    upsert = (items: ReadonlyArray<T>): ReadonlyArray<StoreChange<T>> => {
        const before = this.current as Map<EntityId, T>
        const result = upsert({
            before,
            items
        })
        return this.commit(result.after, result.changes)
    }

    replace = (items: ReadonlyArray<T>): ReadonlyArray<StoreChange<T>> => {
        const before = this.current as Map<EntityId, T>
        const result = replace({
            before,
            items
        })
        return this.commit(result.after, result.changes)
    }
}
