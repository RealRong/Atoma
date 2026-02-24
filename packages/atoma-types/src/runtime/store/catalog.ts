import type {
    Entity,
    Query,
    QueryResult,
    Store,
    StoreChange,
    StoreOperationOptions,
    StoreToken
} from '../../core'
import type { EntityId } from '../../shared'
import type { StoreState } from './state'

export type StoreReconcileMode = 'upsert' | 'replace' | 'remove'
export type StoreHydrateMode = 'refresh' | 'missing'
export type StoreReconcileInput = Readonly<
    | {
        mode: 'upsert' | 'replace'
        items: ReadonlyArray<unknown>
    }
    | {
        mode: 'remove'
        ids: ReadonlyArray<EntityId>
    }
>

export type StoreReconcileResult<T extends Entity = Entity> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    items: ReadonlyArray<T>
    results: ReadonlyArray<T | undefined>
}>

export type StoreSession<T extends Entity = Entity> = Readonly<{
    name: StoreToken
    query: (query: Query<T>) => QueryResult<T>
    apply: (changes: ReadonlyArray<StoreChange<T>>, options?: StoreOperationOptions) => Promise<void>
    revert: (changes: ReadonlyArray<StoreChange<T>>, options?: StoreOperationOptions) => Promise<void>
    reconcile: (
        input: StoreReconcileInput,
        options?: StoreOperationOptions
    ) => Promise<StoreReconcileResult<T>>
    hydrate: (
        ids: ReadonlyArray<EntityId>,
        options?: StoreOperationOptions & Readonly<{ mode?: StoreHydrateMode }>
    ) => Promise<ReadonlyMap<EntityId, T>>
}>

export type StoreCatalog = Readonly<{
    ensure: <T extends Entity = Entity>(name: StoreToken) => Store<T>
    use: <T extends Entity = Entity>(name: StoreToken) => StoreSession<T>
    inspect: <T extends Entity = Entity>(name: StoreToken) => Readonly<{
        snapshot: ReadonlyMap<EntityId, T>
        indexes: StoreState<T>['indexes']
    }>
    list: () => StoreToken[]
}>
