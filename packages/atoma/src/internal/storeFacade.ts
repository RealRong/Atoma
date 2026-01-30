import type { Entity, StoreApi } from 'atoma-core'
import type { AtomaClient } from 'atoma-client'

export type StoreFacade<T extends Entity = any, Relations = any> =
    & StoreApi<T, Relations>
    & Readonly<{
        name: string
        client: AtomaClient<any, any>
    }>

export function assertStoreFacade<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    tag: string
): StoreFacade<T, Relations> {
    const facade = store as unknown as Partial<StoreFacade<T, Relations>>
    const client = facade.client
    const name = facade.name

    if (!client || typeof client !== 'object') {
        throw new Error(`[Atoma] ${tag}: store 缺少 client（请使用 client.stores.* 获取 store）`)
    }
    if (!name) {
        throw new Error(`[Atoma] ${tag}: store 缺少 name（请使用 client.stores.* 获取 store）`)
    }

    return store as unknown as StoreFacade<T, Relations>
}
