import type { Engine as EngineType, StoreState } from 'atoma-types/runtime'
import type { Entity, Query, IndexesLike, IndexDefinition } from 'atoma-types/core'
import { Indexes } from 'atoma-core/indexes'
import { init, merge, addMany, removeMany, preserveRef, upsertItems, writeback } from 'atoma-core/store'
import { createOperationContext } from 'atoma-core/operation'
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
            state: StoreState<T>
            query: Query<T>
        }) => {
            return runQuery({
                snapshot: state.getSnapshot(),
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
        init,
        merge,
        addMany,
        removeMany,
        preserveRef,
        upsertItems,
        writeback
    }

    readonly operation = {
        createContext: createOperationContext
    }
}
