import type { Entity, IndexesLike, StoreChange, StoreDelta, StoreWritebackEntry } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Engine, StoreState as StoreStateType } from 'atoma-types/runtime'
import { mergeChanges, toChange } from 'atoma-core/store'

export class StoreState<T extends Entity = Entity> implements StoreStateType<T> {
    private current: ReadonlyMap<EntityId, T>
    private listeners = new Set<() => void>()
    private readonly engine: Engine
    readonly indexes: IndexesLike<T> | null

    constructor({
        initial,
        indexes,
        engine
    }: {
        initial?: ReadonlyMap<EntityId, T>
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

    private commit = (
        before: Map<EntityId, T>,
        after: Map<EntityId, T>,
        changes: ReadonlyArray<StoreChange<T>>
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
        this.indexes?.applyChangedIds(before, after, changedIds)
        this.current = after
        this.notifyListeners()
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
                if (previous === undefined) return
                after.delete(id)
                normalized.push(toChange({
                    id,
                    before: previous
                }))
                return
            }
            const preserved = this.engine.mutation.reuse(previous, target)
            if (previous === preserved) return

            after.set(id, preserved)
            if (previous === undefined) {
                normalized.push(toChange({
                    id,
                    after: preserved
                }))
                return
            }
            normalized.push(toChange({
                id,
                before: previous,
                after: preserved
            }))
        })

        return this.commit(before, after, normalized)
    }

    writeback = (entries: ReadonlyArray<StoreWritebackEntry<T>>): StoreDelta<T> | null => {
        const before = this.current as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, entries)
        if (!result) return null

        return this.commit(
            result.before,
            result.after,
            result.changes
        )
    }
}
