import { buildMatcher } from 'atoma-core/query'
import { Indexes } from 'atoma-core/indexes'
import type { Entity, IndexDefinition, QueryMatcherOptions, IndexesLike } from 'atoma-types/core'
import type { RuntimeIndexes } from 'atoma-types/runtime'

export class CoreIndexEngine implements RuntimeIndexes {
    create = <T extends Entity>(definitions?: IndexDefinition<T>[] | null): IndexesLike<T> | null => {
        if (!definitions?.length) return null
        return new Indexes<T>(definitions)
    }

    matcher = <T extends Entity>(definitions?: IndexDefinition<T>[] | null): QueryMatcherOptions | undefined => {
        return buildMatcher(definitions ?? undefined)
    }
}
