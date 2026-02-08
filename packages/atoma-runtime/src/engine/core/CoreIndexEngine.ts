import { buildQueryMatcherOptions } from 'atoma-core/query'
import { StoreIndexes } from 'atoma-core/indexes'
import type { Entity, IndexDefinition, QueryMatcherOptions, StoreIndexesLike } from 'atoma-types/core'
import type { RuntimeIndexes } from 'atoma-types/runtime'

export class CoreIndexEngine implements RuntimeIndexes {
    create = <T extends Entity>(definitions?: IndexDefinition<T>[] | null): StoreIndexesLike<T> | null => {
        if (!definitions?.length) return null
        return new StoreIndexes<T>(definitions)
    }

    matcherOptions = <T extends Entity>(definitions?: IndexDefinition<T>[] | null): QueryMatcherOptions | undefined => {
        return buildQueryMatcherOptions(definitions ?? undefined)
    }
}
