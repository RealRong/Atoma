import type { IndexEngine } from './indexes'
import type { MutationEngine } from './mutation'
import type { OperationEngine } from './operation'
import type { QueryEngine } from './query'
import type { RelationEngine } from './relations'

export type Engine = Readonly<{
    index: IndexEngine
    query: QueryEngine
    relation: RelationEngine
    mutation: MutationEngine
    operation: OperationEngine
}>
