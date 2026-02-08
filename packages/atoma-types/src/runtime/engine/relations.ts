import type { Entity, IStore, RelationMap, StoreToken } from '../../core'
import type { RuntimeRelationInclude, RuntimeRelationPrefetchOptions, RuntimeStoreMap } from './shared'

export type RuntimeRelations = Readonly<{
    compileMap: (relationsRaw: unknown, storeName: string) => Record<string, unknown>
    collectStores: <T extends Entity>(
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined
    ) => StoreToken[]
    project: <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        getStoreMap: (store: StoreToken) => RuntimeStoreMap | undefined
    ) => T[]
    prefetch: <T extends Entity>(
        items: T[],
        include: RuntimeRelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => IStore<any> | undefined,
        options?: RuntimeRelationPrefetchOptions
    ) => Promise<void>
}>
