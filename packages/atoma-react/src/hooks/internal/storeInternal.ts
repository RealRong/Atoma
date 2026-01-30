import type { Entity, StoreApi } from 'atoma-core'
import { assertStoreFacade } from 'atoma/internal'

export function requireStoreOwner<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    tag: string
) {
    const facade = assertStoreFacade(store, tag)
    return { client: facade.client, storeName: facade.name }
}

export function getStoreRuntimeKey<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    tag: string
): object {
    return requireStoreOwner(store, tag).client
}
