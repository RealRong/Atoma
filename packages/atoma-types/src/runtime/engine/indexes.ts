import type { Entity, IndexDefinition, IndexesLike } from '../../core'

export type RuntimeIndexes = Readonly<{
    create: <T extends Entity>(definitions?: IndexDefinition<T>[] | null) => IndexesLike<T> | null
}>
