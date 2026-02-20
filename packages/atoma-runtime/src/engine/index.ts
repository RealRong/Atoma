import type { Engine as EngineType, QueryState } from 'atoma-types/runtime'
import type { Entity, Query, IndexesLike, IndexDefinition } from 'atoma-types/core'
import { Indexes } from 'atoma-core/indexes'
import { create, merge, putMany, deleteMany, reuse, upsertMany, writeback } from 'atoma-core/store'
import { createActionContext } from 'atoma-core/action'
import { runQuery } from 'atoma-core/query'
import { projectRelationsBatch } from 'atoma-core/relations'
import { prefetchRelations } from '../relations/prefetch'

export class Engine implements EngineType {
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
        create,
        merge,
        putMany,
        deleteMany,
        reuse,
        upsertMany,
        writeback
    }

    readonly action = {
        createContext: createActionContext
    }
}
