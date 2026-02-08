import type * as Types from '../core'
import type { EntityId } from '../protocol'

export type RuntimeCacheWriteDecision =
    | { effectiveSkipStore: true; reason: 'select' | 'include' }
    | { effectiveSkipStore: false; reason?: undefined }

export type RuntimeRelationInclude = Record<string, boolean | Types.Query<unknown>> | undefined

export type RuntimeRelationPrefetchOptions = {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

export type RuntimeStoreMap<T extends Types.Entity = Types.Entity> =
    | Map<EntityId, T>
    | {
        map: Map<EntityId, T>
        indexes?: Types.StoreIndexesLike<T> | null
    }

export type RuntimeEngine = Readonly<{
    createIndexes: <T extends Types.Entity>(definitions?: Types.IndexDefinition<T>[] | null) => Types.StoreIndexesLike<T> | null
    buildQueryMatcherOptions: <T extends Types.Entity>(definitions?: Types.IndexDefinition<T>[] | null) => Types.QueryMatcherOptions | undefined
    compileRelationsMap: (relationsRaw: unknown, storeName: string) => Record<string, unknown>
    evaluateWithIndexes: <T extends Types.Entity>(args: {
        mapRef: Map<EntityId, T>
        query: Types.Query<T>
        indexes: Types.StoreIndexesLike<T> | null
        matcher?: Types.QueryMatcherOptions
    }) => { data: T[]; pageInfo?: unknown }
    resolveCachePolicy: <T>(query?: Types.Query<T>) => RuntimeCacheWriteDecision
    collectRelationStoreTokens: <T extends Types.Entity>(
        include: RuntimeRelationInclude,
        relations: Types.RelationMap<T> | undefined
    ) => Types.StoreToken[]
    projectRelationsBatch: <T extends Types.Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: Types.RelationMap<T> | undefined,
        getStoreMap: (store: Types.StoreToken) => RuntimeStoreMap | undefined
    ) => T[]
    prefetchRelations: <T extends Types.Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: Types.RelationMap<T> | undefined,
        resolveStore: (name: Types.StoreToken) => Types.IStore<any> | undefined,
        options?: RuntimeRelationPrefetchOptions
    ) => Promise<void>
    initBaseObject: <T>(obj: Partial<T>, idGenerator?: () => EntityId) => Types.PartialWithId<T>
    mergeForUpdate: <T>(base: Types.PartialWithId<T>, patch: Types.PartialWithId<T>) => Types.PartialWithId<T>
    bulkAdd: <T>(items: Types.PartialWithId<T>[], data: Map<EntityId, T>) => Map<EntityId, T>
    bulkRemove: <T>(ids: EntityId[], data: Map<EntityId, T>) => Map<EntityId, T>
    preserveReferenceShallow: <T>(existing: T | undefined, incoming: T) => T
    applyWritebackToMap: <T extends Types.Entity>(
        before: Map<EntityId, T>,
        args: Types.StoreWritebackArgs<T>,
        options?: Types.StoreWritebackOptions<T>
    ) => Types.StoreWritebackResult<T> | null
    normalizeOperationContext: (
        ctx: Types.OperationContext | undefined,
        options?: { defaultScope?: string; defaultOrigin?: Types.OperationOrigin }
    ) => Types.OperationContext
}>
