import type { Entity, Query, QueryResult, Store, StoreToken } from '../core'
import type { EntityId } from '../shared'
import type { Engine, StoreMap } from '../runtime'

export const STORE_BINDINGS = Symbol.for('atoma.store.bindings')

export type StoreSource<T extends Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
}>

export type StoreBindings<T extends Entity = Entity> = Readonly<{
    name: string
    scope: object
    source: StoreSource<T>
    state: () => StoreMap<T>
    query: (query: Query<T>) => QueryResult<T>
    relation: Engine['relation']
    relations?: () => unknown | undefined
    useStore: (name: StoreToken) => Store<Entity, {}>
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
