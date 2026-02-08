import type { Entity, IndexDefinition, QueryMatcherOptions, IndexesLike } from '../../core'

export type RuntimeIndexes = Readonly<{
    create: <T extends Entity>(definitions?: IndexDefinition<T>[] | null) => IndexesLike<T> | null
    matcherOptions: <T extends Entity>(definitions?: IndexDefinition<T>[] | null) => QueryMatcherOptions | undefined
}>
