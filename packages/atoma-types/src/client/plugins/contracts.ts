import type {
    ActionContext,
    Entity,
    Query,
    QueryResult,
    StoreChange,
    Store,
    StoreToken,
    StoreDelta
} from '../../core'
import type { EntityId } from '../../shared'
import type { Runtime, StoreEvents } from '../../runtime'
import type { ServiceRegistry, ServiceToken } from '../services'

export type EventRegister = (events: StoreEvents) => () => void

export type PluginEvents = Readonly<{
    register: EventRegister
}>

export type PluginServices = Readonly<{
    register: ServiceRegistry['register']
    resolve: ServiceRegistry['resolve']
}>

export type StoreActionOptions = Readonly<{
    context?: Partial<ActionContext>
}>

export type WritebackData<T extends Entity> = Readonly<{
    upserts: T[]
    deletes: EntityId[]
    versionUpdates?: Array<{ id: EntityId; version: number }>
}>

export type PluginRuntime = Readonly<{
    id: Runtime['id']
    now: Runtime['now']
    stores: Readonly<{
        list: () => StoreToken[]
        ensure: <T extends Entity>(storeName: StoreToken) => Store<T>
        query: <T extends Entity>(storeName: StoreToken, query: Query<T>) => QueryResult<T>
        apply: <T extends Entity>(
            storeName: StoreToken,
            changes: ReadonlyArray<StoreChange<T>>,
            options?: StoreActionOptions
        ) => Promise<void>
        revert: <T extends Entity>(
            storeName: StoreToken,
            changes: ReadonlyArray<StoreChange<T>>,
            options?: StoreActionOptions
        ) => Promise<void>
        writeback: <T extends Entity>(
            storeName: StoreToken,
            data: WritebackData<T>,
            options?: StoreActionOptions
        ) => Promise<StoreDelta<T> | null>
    }>
    action: Readonly<{
        createContext: (context?: Partial<ActionContext>) => ActionContext
    }>
    execution: Readonly<{
        apply: Runtime['execution']['apply']
        subscribe: Runtime['execution']['subscribe']
    }>
    snapshot: Readonly<{
        store: Runtime['debug']['snapshotStore']
        indexes: Runtime['debug']['snapshotIndexes']
    }>
}>

export type PluginInitResult<Ext = unknown> = Readonly<{
    extension?: Ext
    dispose?: () => void
}>

export type ClientPlugin<Ext = unknown> = Readonly<{
    id: string
    provides?: ReadonlyArray<ServiceToken<unknown>>
    requires?: ReadonlyArray<ServiceToken<unknown>>
    setup?: (ctx: PluginContext) => void | PluginInitResult<Ext>
}>

export type PluginContext = Readonly<{
    clientId: string
    services: PluginServices
    runtime: PluginRuntime
    events: PluginEvents
}>
