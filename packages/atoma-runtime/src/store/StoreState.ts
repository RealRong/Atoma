import type { Entity, IndexesLike, StoreChange, StoreDelta, StoreWritebackArgs } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Engine, StoreSnapshot, StoreState } from 'atoma-types/runtime'
import { mergeChanges, toChange } from 'atoma-core/store'

export class SimpleStoreState<T extends Entity = Entity> implements StoreState<T> {
    private current: StoreSnapshot<T>
    private listeners = new Set<() => void>()
    private readonly engine: Engine
    readonly indexes: IndexesLike<T> | null

    constructor({
        initial,
        indexes,
        engine
    }: {
        initial?: StoreSnapshot<T>
        indexes?: IndexesLike<T> | null
        engine: Engine
    }) {
        this.current = initial ?? new Map<EntityId, T>()
        this.indexes = indexes ?? null
        this.engine = engine
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

    private applyDelta = (delta: StoreDelta<T>) => {
        if (delta.before === delta.after || !delta.changedIds.size) return

        this.indexes?.applyChangedIds(delta.before, delta.after, delta.changedIds)
        this.current = delta.after
        this.notifyListeners()
    }

    private commitDelta = (
        before: Map<EntityId, T>,
        after: Map<EntityId, T>,
        changes: StoreChange<T>[]
    ): StoreDelta<T> | null => {
        if (before === after || !changes.length) return null
        const changedIds = new Set<EntityId>()
        changes.forEach((change) => {
            changedIds.add(change.id)
        })
        if (!changedIds.size) return null

        const delta: StoreDelta<T> = {
            before,
            after,
            changedIds,
            changes
        }
        this.applyDelta(delta)
        return delta
    }

    apply = (changes: ReadonlyArray<StoreChange<T>>): StoreDelta<T> | null => {
        if (!changes.length) return null

        const before = this.current as Map<EntityId, T>
        const after = new Map(before)
        const normalized: StoreChange<T>[] = []

        mergeChanges(changes).forEach((change) => {
            const id = change.id
            const previous = before.get(id)
            const target = change.after
            if (target === undefined) {
                if (!after.has(id) || previous === undefined) return
                after.delete(id)
                normalized.push(toChange({
                    id,
                    before: previous
                }))
                return
            }
            const existing = after.get(id)
            const preserved = this.engine.mutation.reuse(existing, target)
            if (after.has(id) && existing === preserved) return
            after.set(id, preserved)

            if (previous === undefined) {
                normalized.push(toChange({
                    id,
                    after: preserved
                }))
                return
            }
            if (previous === preserved) return
            normalized.push(toChange({
                id,
                before: previous,
                after: preserved
            }))
        })

        return this.commitDelta(before, after, normalized)
    }

    writeback = (writeback: StoreWritebackArgs<T>): StoreDelta<T> | null => {
        const before = this.current as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, writeback)
        if (!result) return null

        this.applyDelta(result)
        return result
    }
}
