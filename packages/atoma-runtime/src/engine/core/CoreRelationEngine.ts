import {
    RelationResolver,
    collectRelationStoreTokens,
    compileRelationsMap,
    projectRelationsBatch
} from 'atoma-core/relations'
import type { Entity, IStore, RelationMap, StoreToken } from 'atoma-types/core'
import type {
    RuntimeRelations,
    RuntimeRelationInclude,
    RuntimeRelationPrefetchOptions,
    RuntimeStoreMap
} from 'atoma-types/runtime'

export class CoreRelationEngine implements RuntimeRelations {
    compileMap = (relationsRaw: unknown, storeName: string): Record<string, unknown> => {
        return compileRelationsMap(relationsRaw, storeName)
    }

    collectStores = <T extends Entity>(
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined
    ): StoreToken[] => {
        return collectRelationStoreTokens(include, relations)
    }

    project = <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        getStoreMap: (store: StoreToken) => RuntimeStoreMap | undefined
    ): T[] => {
        return projectRelationsBatch(items, include, relations, getStoreMap as (store: StoreToken) => any)
    }

    prefetch = async <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => IStore<any> | undefined,
        options?: RuntimeRelationPrefetchOptions
    ): Promise<void> => {
        await RelationResolver.prefetchBatch(
            items,
            include,
            relations,
            resolveStore,
            options
        )
    }
}
