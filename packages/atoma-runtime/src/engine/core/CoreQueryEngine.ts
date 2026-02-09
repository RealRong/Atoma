import { runQuery } from 'atoma-core/query'
import type { Entity, PageInfo, Query } from 'atoma-types/core'
import type { RuntimeQuery, StoreState } from 'atoma-types/runtime'

export class CoreQueryEngine implements RuntimeQuery {
    evaluate = <T extends Entity>(args: {
        state: StoreState<T>
        query: Query<T>
    }): { data: T[]; pageInfo?: PageInfo } => {
        const result = runQuery({
            snapshot: args.state.getSnapshot(),
            query: args.query,
            indexes: args.state.indexes
        })

        return {
            data: result.data,
            pageInfo: result.pageInfo
        }
    }
}
