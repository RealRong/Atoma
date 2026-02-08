import { StoreIndexes } from 'atoma-core/indexes'
import {
    RelationResolver,
    collectRelationStoreTokens,
    compileRelationsMap,
    projectRelationsBatch
} from 'atoma-core/relations'
import { buildQueryMatcherOptions, evaluateWithIndexes, resolveCachePolicy } from 'atoma-core/query'
import {
    applyWritebackToMap,
    bulkAdd,
    bulkRemove,
    initBaseObject,
    mergeForUpdate,
    preserveReferenceShallow
} from 'atoma-core/store'
import { normalizeOperationContext } from 'atoma-core/operation'
import type {
    Entity,
    IndexDefinition,
    OperationContext,
    OperationOrigin,
    PartialWithId,
    Query,
    QueryMatcherOptions,
    RelationMap,
    StoreIndexesLike,
    StoreToken,
    StoreWritebackArgs,
    StoreWritebackOptions,
    StoreWritebackResult,
    IStore
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type {
    RuntimeCacheWriteDecision,
    RuntimeEngine,
    RuntimeRelationInclude,
    RuntimeRelationPrefetchOptions,
    RuntimeStoreMap
} from 'atoma-types/runtime'

export class CoreRuntimeEngine implements RuntimeEngine {
    createIndexes = <T extends Entity>(definitions?: IndexDefinition<T>[] | null): StoreIndexesLike<T> | null => {
        if (!definitions?.length) return null
        return new StoreIndexes<T>(definitions)
    }

    buildQueryMatcherOptions = <T extends Entity>(definitions?: IndexDefinition<T>[] | null): QueryMatcherOptions | undefined => {
        return buildQueryMatcherOptions(definitions ?? undefined)
    }

    compileRelationsMap = (relationsRaw: unknown, storeName: string): Record<string, unknown> => {
        return compileRelationsMap(relationsRaw, storeName)
    }

    evaluateWithIndexes = <T extends Entity>(args: {
        mapRef: Map<EntityId, T>
        query: Query<T>
        indexes: StoreIndexesLike<T> | null
        matcher?: QueryMatcherOptions
    }): { data: T[]; pageInfo?: unknown } => {
        const result = evaluateWithIndexes({
            mapRef: args.mapRef,
            query: args.query,
            indexes: args.indexes as StoreIndexes<T> | null,
            matcher: args.matcher
        })

        return {
            data: result.data,
            pageInfo: result.pageInfo
        }
    }

    resolveCachePolicy = <T>(query?: Query<T>): RuntimeCacheWriteDecision => {
        return resolveCachePolicy(query)
    }

    collectRelationStoreTokens = <T extends Entity>(
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined
    ): StoreToken[] => {
        return collectRelationStoreTokens(include, relations)
    }

    projectRelationsBatch = <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        getStoreMap: (store: StoreToken) => RuntimeStoreMap | undefined
    ): T[] => {
        return projectRelationsBatch(items, include, relations, getStoreMap as (store: StoreToken) => any)
    }

    prefetchRelations = async <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => IStore<any> | undefined,
        options?: RuntimeRelationPrefetchOptions
    ): Promise<void> => {
        await RelationResolver.prefetchBatch(
            items,
            include,
            relations,
            resolveStore,
            options
        )
    }

    initBaseObject = <T>(obj: Partial<T>, idGenerator?: () => EntityId): PartialWithId<T> => {
        return initBaseObject(obj, idGenerator)
    }

    mergeForUpdate = <T>(base: PartialWithId<T>, patch: PartialWithId<T>): PartialWithId<T> => {
        return mergeForUpdate(base, patch)
    }

    bulkAdd = <T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> => {
        return bulkAdd(items, data)
    }

    bulkRemove = <T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> => {
        return bulkRemove(ids, data)
    }

    preserveReferenceShallow = <T>(existing: T | undefined, incoming: T): T => {
        return preserveReferenceShallow(existing, incoming)
    }

    applyWritebackToMap = <T extends Entity>(
        before: Map<EntityId, T>,
        args: StoreWritebackArgs<T>,
        options?: StoreWritebackOptions<T>
    ): StoreWritebackResult<T> | null => {
        return applyWritebackToMap(before, args, options)
    }

    normalizeOperationContext = (
        ctx: OperationContext | undefined,
        options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
    ): OperationContext => {
        return normalizeOperationContext(ctx, options)
    }
}
