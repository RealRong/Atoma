import type { Engine as EngineType, QueryState } from '@atoma-js/types/runtime'
import type { ActionContext, ActionOrigin, Entity, Query } from '@atoma-js/types/core'
import { merge, putMany, deleteMany, reuse, upsertMany, writeback } from '@atoma-js/core/store'
import { createActionContext } from '@atoma-js/core/action'
import { runQuery } from '@atoma-js/core/query'
import { prefetchRelations } from '../relations/prefetch'
import { projectRelationsBatch } from '../relations/project'

export class Engine implements EngineType {
    private readonly now: () => number

    constructor({ now }: { now?: () => number }) {
        this.now = now ?? Date.now
    }

    readonly query = {
        evaluate: <T extends Entity>({ state, query }: {
            state: QueryState<T>
            query: Query<T>
        }) => {
            return runQuery({
                snapshot: state.snapshot(),
                query,
                indexes: state.indexes
            })
        }
    }

    readonly relation = {
        project: projectRelationsBatch,
        prefetch: prefetchRelations
    }

    readonly mutation = {
        merge,
        putMany,
        deleteMany,
        reuse,
        upsertMany,
        writeback
    }

    readonly action = {
        createContext: (
            context?: Partial<ActionContext>,
            options?: { defaultScope?: string; defaultOrigin?: ActionOrigin }
        ) => {
            return createActionContext(context, {
                ...options,
                now: this.now
            })
        }
    }
}
