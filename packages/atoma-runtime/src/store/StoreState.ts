import { applyPatches as applyImmerPatches, produceWithPatches, type Patch } from 'immer'
import type { Entity, IndexesLike, StoreDelta, StoreWritebackArgs } from 'atoma-types/core'
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

    private collectChangedIdsFromPatches = (patches: Patch[], inversePatches: Patch[]): Set<EntityId> => {
        const changedIds = new Set<EntityId>()
        const collect = (list: Patch[]) => {
            list.forEach((patch) => {
                const root = patch.path?.[0]
                if (typeof root !== 'string' && typeof root !== 'number') return
                const id = String(root)
                if (!id) return
                changedIds.add(id)
            })
        }
        collect(patches)
        collect(inversePatches)
        return changedIds
    }

    private applyDelta = (delta: StoreDelta<T>) => {
        if (delta.before === delta.after || !delta.changedIds.size) return

        this.indexes?.applyChangedIds(delta.before, delta.after, delta.changedIds)
        this.snapshot = delta.after
        this.notifyListeners()
    }

    mutate = (recipe: (draft: Map<EntityId, T>) => void): StoreDelta<T> | null => {
        const before = this.snapshot as Map<EntityId, T>
        const [after, patches, inversePatches] = produceWithPatches(before, recipe)
        const changedIds = this.collectChangedIdsFromPatches(patches, inversePatches)
        if (before === after || !changedIds.size) return null

        const delta: StoreDelta<T> = {
            before,
            after,
            changedIds,
            patches,
            inversePatches
        }
        this.applyDelta(delta)
        return delta
    }

    applyWriteback = (args: StoreWritebackArgs<T>): StoreDelta<T> | null => {
        const before = this.snapshot as Map<EntityId, T>
        const result = this.engine.mutation.writeback(before, args)
        if (!result) return null

        this.applyDelta(result)
        return result
    }

    applyPatches = (patches: Patch[]): StoreDelta<T> | null => {
        if (!patches.length) return null

        const before = this.snapshot as Map<EntityId, T>
        const [after, nextPatches, inversePatches] = produceWithPatches(
            before,
            ((draft: Map<EntityId, T>) => {
                return applyImmerPatches(draft as unknown as Map<EntityId, T>, patches) as Map<EntityId, T>
            }) as any
        )
        const changedIds = this.collectChangedIdsFromPatches(nextPatches, inversePatches)
        if (before === after || !changedIds.size) return null

        const delta: StoreDelta<T> = {
            before,
            after,
            changedIds,
            patches: nextPatches,
            inversePatches
        }
        this.applyDelta(delta)
        return delta
    }
}
