import type { Entity, IndexesLike, StoreChange, StoreDelta, StoreWritebackArgs } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Engine, StoreSnapshot, StoreState } from 'atoma-types/runtime'

export class SimpleStoreState<T extends Entity = Entity> implements StoreState<T> {
    private snapshot: StoreSnapshot<T>
    private listeners = new Set<() => void>()
    private readonly engine: Engine
    readonly indexes: IndexesLike<T> | null

    constructor(args: {
        initial?: StoreSnapshot<T>
        indexes?: IndexesLike<T> | null
        engine: Engine
    }) {
        this.snapshot = args.initial ?? new Map<EntityId, T>()
        this.indexes = args.indexes ?? null
        this.engine = args.engine
    }

    getSnapshot = () => this.snapshot

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

    private buildChanges = (before: Map<EntityId, T>, after: Map<EntityId, T>, changedIds: ReadonlySet<EntityId>): StoreChange<T>[] => {
        const changes: StoreChange<T>[] = []
        changedIds.forEach((id) => {
            changes.push({
                id,
                ...(before.has(id) ? { before: before.get(id) as T } : {}),
                ...(after.has(id) ? { after: after.get(id) as T } : {})
            })
        })
        return changes
    }

    private collectChangedIds = (before: Map<EntityId, T>, after: Map<EntityId, T>): Set<EntityId> => {
        const changedIds = new Set<EntityId>()

        before.forEach((beforeValue, id) => {
            if (!after.has(id)) {
                changedIds.add(id)
                return
            }
            const afterValue = after.get(id) as T
            if (beforeValue !== afterValue) {
                changedIds.add(id)
            }
        })

        after.forEach((afterValue, id) => {
            if (!before.has(id)) {
                changedIds.add(id)
                return
            }
            const beforeValue = before.get(id) as T
            if (beforeValue !== afterValue) {
                changedIds.add(id)
            }
        })

        return changedIds
    }

    private applyDelta = (delta: StoreDelta<T>) => {
        if (delta.before === delta.after || !delta.changedIds.size) return

        this.indexes?.applyChangedIds(delta.before, delta.after, delta.changedIds)
        this.snapshot = delta.after
        this.notifyListeners()
    }

    private commit = (before: Map<EntityId, T>, after: Map<EntityId, T>): StoreDelta<T> | null => {
        if (before === after) return null
        const changedIds = this.collectChangedIds(before, after)
        if (!changedIds.size) return null

        const delta: StoreDelta<T> = {
            before,
            after,
            changedIds,
            changes: this.buildChanges(before, after, changedIds)
        }
        this.applyDelta(delta)
        return delta
    }

    mutate = (recipe: (draft: Map<EntityId, T>) => void): StoreDelta<T> | null => {
        const before = this.snapshot as Map<EntityId, T>
        const draft = new Map(before)
        recipe(draft)
        return this.commit(before, draft)
    }

    applyChanges = (changes: ReadonlyArray<StoreChange<T>>): StoreDelta<T> | null => {
        if (!changes.length) return null

        const before = this.snapshot as Map<EntityId, T>
        const next = new Map(before)
        changes.forEach((change) => {
            const id = change.id
            const target = change.after
            if (target === undefined) {
                if (!next.has(id)) return
                next.delete(id)
                return
            }
            const existing = next.get(id)
            const preserved = this.engine.mutation.reuse(existing, target)
            if (next.has(id) && existing === preserved) return
            next.set(id, preserved)
        })

        return this.commit(before, next)
    }

    applyWriteback = (args: StoreWritebackArgs<T>): StoreDelta<T> | null => {
        const before = this.snapshot as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, args)
        if (!result) return null

        this.applyDelta(result)
        return result
    }
}
