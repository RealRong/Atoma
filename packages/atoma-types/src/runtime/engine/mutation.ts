import type {
    Entity,
    PartialWithId,
    StoreDelta,
    StoreWritebackArgs,
} from '../../core'
import type { EntityId } from '../../shared'

export type MutationEngine = Readonly<{
    create: <T>(obj: Partial<T>, createId?: () => EntityId) => PartialWithId<T>
    merge: <T>(base: PartialWithId<T>, patch: PartialWithId<T>) => PartialWithId<T>
    putMany: <T>(items: PartialWithId<T>[], data: Map<EntityId, T>) => Map<EntityId, T>
    deleteMany: <T>(ids: EntityId[], data: Map<EntityId, T>) => Map<EntityId, T>
    reuse: <T>(existing: T | undefined, incoming: T) => T
    upsertMany: <T extends { id: EntityId }>(
        before: Map<EntityId, T>,
        items: ReadonlyArray<T>
    ) => {
        after: Map<EntityId, T>
        items: T[]
    }
    writeback: <T extends Entity>(
        before: Map<EntityId, T>,
        args: StoreWritebackArgs<T>
    ) => StoreDelta<T> | null
}>
