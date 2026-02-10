import type { Entity, Store, IndexesLike, StoreToken } from '../core'
import type { EntityId } from '../shared'
import type { Engine } from '../runtime'

export const STORE_BINDINGS = Symbol.for('atoma.store.bindings')

export type StoreSource<T extends Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
}>

export type StoreBindings<T extends Entity = Entity> = Readonly<{
    name: string
    cacheKey: object
    source: StoreSource<T>
    engine: Engine
    indexes: IndexesLike<T> | null
    relations?: () => unknown | undefined
    ensureStore: (name: StoreToken) => Store<Entity, unknown>
    hydrate?: (items: T[]) => Promise<void>
}>

export function getStoreBindings<T extends Entity, Relations = unknown>(
    store: Store<T, Relations>,
    tag: string
): StoreBindings<T> {
    const bindings = (store as unknown as { [STORE_BINDINGS]?: StoreBindings<T> })[STORE_BINDINGS]
    if (!bindings) {
        throw new Error(`[Atoma] ${tag}: store 缺少内部绑定（StoreBindings）`)
    }
    return bindings
}
