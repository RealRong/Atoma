import type {
    Entity,
    Query,
    QueryResult,
    Store,
    StoreChange,
    StoreDelta,
    StoreOperationOptions,
    StoreToken,
    StoreWritebackEntry,
} from '../../core'
import type { EntityId } from '../../shared'
import type { StoreState } from './state'

export type StoreSession<T extends Entity = Entity> = Readonly<{
    name: StoreToken
    query: (query: Query<T>) => QueryResult<T>
    apply: (changes: ReadonlyArray<StoreChange<T>>, options?: StoreOperationOptions) => Promise<void>
    revert: (changes: ReadonlyArray<StoreChange<T>>, options?: StoreOperationOptions) => Promise<void>
    writeback: (
        entries: ReadonlyArray<StoreWritebackEntry<T>>,
        options?: StoreOperationOptions
    ) => Promise<StoreDelta<T> | null>
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
