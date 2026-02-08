import { evaluateWithIndexes, resolveCachePolicy } from 'atoma-core/query'
import { StoreIndexes } from 'atoma-core/indexes'
import type { Entity, Query, QueryMatcherOptions, StoreIndexesLike } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { RuntimeCacheWriteDecision, RuntimeQuery } from 'atoma-types/runtime'

export class CoreQueryEngine implements RuntimeQuery {
    evaluate = <T extends Entity>(args: {
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

    cachePolicy = <T>(query?: Query<T>): RuntimeCacheWriteDecision => {
        return resolveCachePolicy(query)
    }
}
