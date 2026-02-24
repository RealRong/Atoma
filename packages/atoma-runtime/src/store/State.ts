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
        const source = changes.length === 1
            ? changes
            : mergeChanges(changes)

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

        source.forEach((change) => {
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

    private writebackEntries = (entries: ReadonlyArray<StoreWritebackEntry<T>>): ReadonlyArray<StoreChange<T>> => {
        const before = this.current as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, entries)

        return this.commit(result.after, result.changes)
    }

    upsert = (items: ReadonlyArray<T>): ReadonlyArray<StoreChange<T>> => {
        if (!items.length) return []
        return this.writebackEntries(items.map((item) => ({
            action: 'upsert' as const,
            item
        })))
    }

    replace = (items: ReadonlyArray<T>): ReadonlyArray<StoreChange<T>> => {
        const before = this.current as Map<EntityId, T>
        const incomingIds = new Set<EntityId>()
        items.forEach((item) => {
            incomingIds.add(item.id)
        })

        let after = before
        let writable = false
        const ensureWritable = (): Map<EntityId, T> => {
            if (!writable) {
                after = new Map(before)
                writable = true
            }
            return after
        }

        const order: EntityId[] = []
        const merged = new Map<EntityId, { before?: T; after?: T }>()
        const record = (id: EntityId, current: T | undefined, next: T | undefined) => {
            const existing = merged.get(id)
            if (!existing) {
                order.push(id)
                merged.set(id, { before: current, after: next })
                return
            }
            existing.after = next
        }

        before.forEach((current, id) => {
            if (incomingIds.has(id)) return
            ensureWritable().delete(id)
            record(id, current, undefined)
        })

        items.forEach((item) => {
            const id = item.id
            const current = after.get(id)
            const hasCurrent = current !== undefined || after.has(id)
            const next = hasCurrent
                ? this.engine.mutation.reuse(current, item)
                : item
            if (hasCurrent && current === next) return
            ensureWritable().set(id, next)
            record(id, current, next)
        })

        if (!order.length) return []
        const changes: StoreChange<T>[] = []
        order.forEach((id) => {
            const change = merged.get(id)
            if (!change) return
            if (change.before === undefined && change.after === undefined) return
            changes.push(toChange({
                id,
                before: change.before,
                after: change.after
            }))
        })
        return this.commit(after, changes)
    }
}
