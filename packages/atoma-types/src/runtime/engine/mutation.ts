import type {
    Entity,
    PartialWithId,
    StoreWritebackArgs,
    StoreWritebackResult,
} from '../../core'
import type { EntityId } from '../../shared'

export type MutationEngine = Readonly<{
    init: <T>(obj: Partial<T>, idGenerator?: () => EntityId) => PartialWithId<T>
    merge: <T>(base: PartialWithId<T>, patch: PartialWithId<T>) => PartialWithId<T>
    addMany: <T>(items: PartialWithId<T>[], data: Map<EntityId, T>) => Map<EntityId, T>
    removeMany: <T>(ids: EntityId[], data: Map<EntityId, T>) => Map<EntityId, T>
    preserveRef: <T>(existing: T | undefined, incoming: T) => T
    upsertItems: <T extends { id: EntityId }>(
        before: Map<EntityId, T>,
        items: ReadonlyArray<T>
    ) => {
        after: Map<EntityId, T>
        items: T[]
    }
    writeback: <T extends Entity>(
        before: Map<EntityId, T>,
        args: StoreWritebackArgs<T>
    ) => StoreWritebackResult<T> | null
}>
