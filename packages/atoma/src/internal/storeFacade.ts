import type { Types } from 'atoma-core'
import type { AtomaClient } from 'atoma-client'

export type StoreFacade<T extends Types.Entity = any, Relations = any> =
    & Types.StoreApi<T, Relations>
    & Readonly<{
        name: string
        client: AtomaClient<any, any>
    }>

export function assertStoreFacade<T extends Types.Entity, Relations>(
    store: Types.StoreApi<T, Relations>,
    tag: string
): StoreFacade<T, Relations> {
    const facade = store as unknown as Partial<StoreFacade<T, Relations>>
    const client = facade.client
    const name = facade.name

    if (!client || typeof client !== 'object') {
        throw new Error(`[Atoma] ${tag}: store 缺少 client（请使用 client.stores('name') 获取 store）`)
    }
    if (!name) {
        throw new Error(`[Atoma] ${tag}: store 缺少 name（请使用 client.stores('name') 获取 store）`)
    }

    return store as unknown as StoreFacade<T, Relations>
}
