import {
    addMany as coreAddMany,
    init as coreInit,
    merge as coreMerge,
    preserveRef as corePreserveRef,
    removeMany as coreRemoveMany,
    writeback as coreWriteback
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
        return coreInit(obj, idGenerator)
    }

    merge = <T>(base: PartialWithId<T>, patch: PartialWithId<T>): PartialWithId<T> => {
        return coreMerge(base, patch)
    }

    addMany = <T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> => {
        return coreAddMany(items, data)
    }

    removeMany = <T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> => {
        return coreRemoveMany(ids, data)
    }

    preserveRef = <T>(existing: T | undefined, incoming: T): T => {
        return corePreserveRef(existing, incoming)
    }

    writeback = <T extends Entity>(
        before: Map<EntityId, T>,
        args: StoreWritebackArgs<T>,
        options?: StoreWritebackOptions<T>
    ): StoreWritebackResult<T> | null => {
        return coreWriteback(before, args, options)
    }
}
