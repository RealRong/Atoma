import type { Entity, IndexesLike, StoreWritebackArgs } from 'atoma-types/core'
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

    setSnapshot = (next: StoreSnapshot<T>) => {
        this.snapshot = next
        this.notifyListeners()
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    private collectChangedIds = (
        before: Map<EntityId, T>,
        after: Map<EntityId, T>
    ): Set<EntityId> => {
        const output = new Set<EntityId>()

        before.forEach((beforeItem, id) => {
            if (!after.has(id)) {
                output.add(id)
                return
            }

            if (after.get(id) !== beforeItem) {
                output.add(id)
            }
        })

        after.forEach((_afterItem, id) => {
            if (!before.has(id)) {
                output.add(id)
            }
        })

        return output
    }

    commit = (params: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds?: ReadonlySet<EntityId>
    }) => {
        const { before, after, changedIds } = params
        const indexes = this.indexes

        if (before === after) return

        const nextChangedIds = changedIds ?? this.collectChangedIds(before, after)
        if (!nextChangedIds.size) return

        indexes?.applyChangedIds(before, after, nextChangedIds)

        this.snapshot = after
        this.notifyListeners()
    }

    applyWriteback = (args: StoreWritebackArgs<T>) => {
        const before = this.snapshot as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, args)
        if (!result) return

        this.commit({
            before: result.before,
            after: result.after,
            changedIds: result.changedIds
        })
    }
}
