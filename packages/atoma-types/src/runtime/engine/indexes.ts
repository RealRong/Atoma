import type { Entity, IndexDefinition, IndexesLike } from '../../core'

export type IndexEngine = Readonly<{
    create: <T extends Entity>(definitions?: IndexDefinition<T>[] | null) => IndexesLike<T> | null
}>
