import type { MutationEngine } from './mutation'
import type { ActionEngine } from './action'
import type { QueryEngine } from './query'
import type { RelationEngine } from './relations'

export type Engine = Readonly<{
    query: QueryEngine
    relation: RelationEngine
    mutation: MutationEngine
    action: ActionEngine
}>
