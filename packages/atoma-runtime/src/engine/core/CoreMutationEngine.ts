import {
    applyWritebackToMap,
    bulkAdd,
    bulkRemove,
    initBaseObject,
    mergeForUpdate,
    preserveReferenceShallow
} from 'atoma-core/store'
import type {
    Entity,
    PartialWithId,
    StoreWritebackArgs,
    StoreWritebackOptions,
    StoreWritebackResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { RuntimeMutation } from 'atoma-types/runtime'

export class CoreMutationEngine implements RuntimeMutation {
    init = <T>(obj: Partial<T>, idGenerator?: () => EntityId): PartialWithId<T> => {
        return initBaseObject(obj, idGenerator)
    }

    merge = <T>(base: PartialWithId<T>, patch: PartialWithId<T>): PartialWithId<T> => {
        return mergeForUpdate(base, patch)
    }

    addMany = <T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> => {
        return bulkAdd(items, data)
    }

    removeMany = <T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> => {
        return bulkRemove(ids, data)
    }

    preserveRef = <T>(existing: T | undefined, incoming: T): T => {
        return preserveReferenceShallow(existing, incoming)
    }

    writeback = <T extends Entity>(
        before: Map<EntityId, T>,
        args: StoreWritebackArgs<T>,
        options?: StoreWritebackOptions<T>
    ): StoreWritebackResult<T> | null => {
        return applyWritebackToMap(before, args, options)
    }
}
