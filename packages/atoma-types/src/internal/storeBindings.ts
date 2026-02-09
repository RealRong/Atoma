import type { Entity, IStore, IndexesLike, StoreApi, StoreToken } from '../core'
import type { EntityId } from '../shared'
import type { RuntimeEngine } from '../runtime'

export const STORE_BINDINGS = Symbol.for('atoma.store.bindings')

export type StoreSource<T extends Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
}>

export type StoreBindings<T extends Entity = any> = Readonly<{
    name: string
    cacheKey: object
    source: StoreSource<T>
    engine: RuntimeEngine
    indexes: IndexesLike<T> | null
    relations?: () => any | undefined
    ensureStore: (name: StoreToken) => IStore<any, any>
    hydrate?: (items: T[]) => Promise<void>
}>

export function getStoreBindings<T extends Entity, Relations = any>(
    store: StoreApi<T, Relations>,
    tag: string
): StoreBindings<T> {
    const bindings = (store as any)?.[STORE_BINDINGS] as StoreBindings<T> | undefined
    if (!bindings) {
        throw new Error(`[Atoma] ${tag}: store 缺少内部绑定（StoreBindings）`)
    }
    return bindings
}
