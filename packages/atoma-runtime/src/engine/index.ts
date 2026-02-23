import type { Engine as EngineType, QueryState } from 'atoma-types/runtime'
import type { ActionContext, ActionOrigin, Entity, Query, IndexesLike, IndexDefinition } from 'atoma-types/core'
import { Indexes } from 'atoma-core/indexes'
import { merge, putMany, deleteMany, reuse, upsertMany, writeback } from 'atoma-core/store'
import { createActionContext } from 'atoma-core/action'
import { runQuery } from 'atoma-core/query'
import { prefetchRelations } from '../relations/prefetch'
import { projectRelationsBatch } from '../relations/project'

export class Engine implements EngineType {
    private readonly now: () => number

    constructor(args?: { now?: () => number }) {
        this.now = args?.now ?? Date.now
    }

    readonly index = {
        create: <T extends Entity>(definitions?: IndexDefinition<T>[] | null): IndexesLike<T> | null => {
            if (!definitions?.length) return null
            return new Indexes<T>(definitions)
        }
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
