import { projectRelationsBatch } from 'atoma-core/relations'
import type { Entity, IStore, RelationMap, StoreToken } from 'atoma-types/core'
import type {
    RuntimeStoreMap,
    RuntimeRelations,
    RuntimeRelationInclude,
    RuntimeRelationPrefetchOptions
} from 'atoma-types/runtime'
import { prefetchRelations } from '../../relations/prefetch'

export class CoreRelationEngine implements RuntimeRelations {
    project = <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        storeStates: ReadonlyMap<StoreToken, RuntimeStoreMap<Entity>>
    ): T[] => {
        return projectRelationsBatch(items, include, relations, storeStates)
    }

    prefetch = async <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => IStore<unknown> | undefined,
        options?: RuntimeRelationPrefetchOptions
    ): Promise<void> => {
        await prefetchRelations(
            items,
            include,
            relations,
            resolveStore,
            options
        )
    }
}
