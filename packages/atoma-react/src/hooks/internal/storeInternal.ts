import type * as Types from 'atoma-types/core'
import { assertStoreFacade } from 'atoma/internal'

export function requireStoreOwner<T extends Types.Entity, Relations>(
    store: Types.StoreApi<T, Relations>,
    tag: string
) {
    const facade = assertStoreFacade(store, tag)
    return { client: facade.client, storeName: facade.name }
}

export function getStoreRuntimeKey<T extends Types.Entity, Relations>(
    store: Types.StoreApi<T, Relations>,
    tag: string
): object {
    return requireStoreOwner(store, tag).client
}
