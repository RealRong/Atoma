import { evaluateWithIndexes, resolveCachePolicy } from 'atoma-core/query'
import { Indexes } from 'atoma-core/indexes'
import type { Entity, Query } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { RuntimeCacheWriteDecision, RuntimeQuery, StoreState } from 'atoma-types/runtime'

export class CoreQueryEngine implements RuntimeQuery {
    evaluate = <T extends Entity>(args: {
        state: StoreState<T>
        query: Query<T>
    }): { data: T[]; pageInfo?: unknown } => {
        const mapRef = args.state.getSnapshot() as Map<EntityId, T>
        const result = evaluateWithIndexes({
            mapRef,
            query: args.query,
            indexes: args.state.indexes as Indexes<T> | null,
            matcher: args.state.matcher
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
