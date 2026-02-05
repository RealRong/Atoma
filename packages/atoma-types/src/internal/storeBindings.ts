import type * as Types from '../core'
import type { EntityId } from '../protocol'

export const STORE_BINDINGS = Symbol.for('atoma.store.bindings')

export type StoreSource<T extends Types.Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
}>

export type StoreBindings<T extends Types.Entity = any> = Readonly<{
    name: string
    cacheKey: object
    source: StoreSource<T>
    indexes?: Types.StoreIndexesLike<T> | null
    matcher?: Types.QueryMatcherOptions
    relations?: () => any | undefined
    ensureStore: (name: Types.StoreToken) => Types.IStore<any, any>
    hydrate?: (items: T[]) => Promise<void>
}>

export function getStoreBindings<T extends Types.Entity, Relations = any>(
    store: Types.StoreApi<T, Relations>,
    tag: string
): StoreBindings<T> {
    const bindings = (store as any)?.[STORE_BINDINGS] as StoreBindings<T> | undefined
    if (!bindings) {
        throw new Error(`[Atoma] ${tag}: store 缺少内部绑定（StoreBindings）`)
    }
    return bindings
}
