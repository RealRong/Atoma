import type { Entity, Indexes, StoreChange, StoreWritebackEntry } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Engine, StoreState as StoreStateType } from 'atoma-types/runtime'
import { mergeChanges, toChange } from 'atoma-core/store'

export class StoreState<T extends Entity = Entity> implements StoreStateType<T> {
    private current: ReadonlyMap<EntityId, T>
    private listeners = new Set<() => void>()
    private readonly engine: Engine
    readonly indexes: Indexes<T> | null

    constructor({
        initial,
        indexes,
        engine
    }: {
        initial?: ReadonlyMap<EntityId, T>
        indexes?: Indexes<T> | null
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
        after: Map<EntityId, T>,
        changes: ReadonlyArray<StoreChange<T>>
    ): ReadonlyArray<StoreChange<T>> => {
        if (!changes.length) return []
        this.indexes?.apply(changes)
        this.current = after
        this.notifyListeners()
        return changes
    }

    apply = (changes: ReadonlyArray<StoreChange<T>>): ReadonlyArray<StoreChange<T>> => {
        if (!changes.length) return []

        const before = this.current as Map<EntityId, T>
        let after = before
        let writable = false
        const ensureWritable = (): Map<EntityId, T> => {
            if (!writable) {
                after = new Map(before)
                writable = true
            }
            return after
        }
        const normalized: StoreChange<T>[] = []

        mergeChanges(changes).forEach((change) => {
            const id = change.id
            const previous = before.get(id)
            const target = change.after
            if (target === undefined) {
                if (previous === undefined) return
                ensureWritable().delete(id)
                normalized.push(toChange({
                    id,
                    before: previous
                }))
                return
            }
            const preserved = this.engine.mutation.reuse(previous, target)
            if (previous === preserved) return

            ensureWritable().set(id, preserved)
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

        return this.commit(after, normalized)
    }

    writeback = (entries: ReadonlyArray<StoreWritebackEntry<T>>): ReadonlyArray<StoreChange<T>> => {
        const before = this.current as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, entries)

        return this.commit(result.after, result.changes)
    }
}
