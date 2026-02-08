import type { RuntimeIndexes } from './indexes'
import type { RuntimeMutation } from './mutation'
import type { RuntimeOperation } from './operation'
import type { RuntimeQuery } from './query'
import type { RuntimeRelations } from './relations'

export type RuntimeEngine = Readonly<{
    index: RuntimeIndexes
    query: RuntimeQuery
    relation: RuntimeRelations
    mutation: RuntimeMutation
    operation: RuntimeOperation
}>
