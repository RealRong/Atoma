import type { Entity, IndexDefinition, QueryMatcherOptions, StoreIndexesLike } from '../../core'

export type RuntimeIndexes = Readonly<{
    create: <T extends Entity>(definitions?: IndexDefinition<T>[] | null) => StoreIndexesLike<T> | null
    matcherOptions: <T extends Entity>(definitions?: IndexDefinition<T>[] | null) => QueryMatcherOptions | undefined
}>
