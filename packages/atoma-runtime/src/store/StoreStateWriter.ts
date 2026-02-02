import { applyWritebackToMap, type StoreWritebackArgs, StoreWriteUtils } from 'atoma-core'
import type { Entity } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { StoreHandle } from '../types/runtimeTypes'
import type { StoreStateWriterApi } from '../types/handleTypes'

type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export class StoreStateWriter<T extends Entity> implements StoreStateWriterApi<T> {
    constructor(private readonly handle: StoreHandle<T>) {}

    commitMapUpdate = (params: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
    }) => {
        this.commitMapUpdateInternal(params)
    }

    commitMapUpdateDelta = (params: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds: ChangedIds
    }) => {
        this.commitMapUpdateInternal(params)
    }

    applyWriteback = (args: StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => {
        const before = this.handle.jotaiStore.get(this.handle.atom)
        const preserve = options?.preserve ?? StoreWriteUtils.preserveReferenceShallow
        const result = applyWritebackToMap(before, args, { preserve })
        if (!result) return

        this.commitMapUpdateDelta({
            before: result.before,
            after: result.after,
            changedIds: result.changedIds
        })
    }

    private commitMapUpdateInternal = (params: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds?: ChangedIds
    }) => {
        const { before, after, changedIds } = params
        const { jotaiStore, atom, indexes } = this.handle

        if (before === after) return

        if (changedIds) {
            const size = Array.isArray(changedIds)
                ? changedIds.length
                : (changedIds as ReadonlySet<EntityId>).size
            if (size === 0) return
        }

        jotaiStore.set(atom, after)
        if (changedIds) {
            indexes?.applyChangedIds(before, after, changedIds)
        } else {
            indexes?.applyMapDiff(before, after)
        }
    }
}
