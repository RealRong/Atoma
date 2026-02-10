import type { Entity, Store, RelationMap, StoreToken } from '../../core'
import type { RelationInclude, RelationPrefetchOptions, StoreMap } from './shared'

export type RelationEngine = Readonly<{
    project: <T extends Entity>(
        items: T[],
        include: RelationInclude,
        relations: RelationMap<T> | undefined,
        storeStates: ReadonlyMap<StoreToken, StoreMap>
    ) => T[]
    prefetch: <T extends Entity>(
        items: T[],
        include: RelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => Store<unknown> | undefined,
        options?: RelationPrefetchOptions
    ) => Promise<void>
}>
