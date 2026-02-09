import type { Entity, IStore, RelationMap, StoreToken } from '../../core'
import type { RuntimeRelationInclude, RuntimeRelationPrefetchOptions, RuntimeStoreMap } from './shared'

export type RuntimeRelations = Readonly<{
    project: <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        storeStates: ReadonlyMap<StoreToken, RuntimeStoreMap>
    ) => T[]
    prefetch: <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => IStore<unknown> | undefined,
        options?: RuntimeRelationPrefetchOptions
    ) => Promise<void>
}>
