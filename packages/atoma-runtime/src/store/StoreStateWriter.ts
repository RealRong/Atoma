import { Store } from 'atoma-core'
import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreHandle } from 'atoma-types/runtime'
import type { StoreStateWriterApi } from 'atoma-types/runtime'

type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export class StoreStateWriter<T extends Types.Entity> implements StoreStateWriterApi<T> {
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

    applyWriteback = (args: Types.StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => {
        const before = this.handle.jotaiStore.get(this.handle.atom)
        const preserve = options?.preserve ?? Store.StoreWriteUtils.preserveReferenceShallow
        const result = Store.applyWritebackToMap(before, args, { preserve })
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
