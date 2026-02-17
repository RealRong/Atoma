import type {
    ChangeDirection,
    OperationContext,
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

export type PluginRuntime = Readonly<{
    id: Runtime['id']
    now: Runtime['now']
    stores: Readonly<{
        list: () => StoreToken[]
        ensure: <T extends Entity>(storeName: StoreToken) => Store<T>
        query: <T extends Entity>(args: {
            storeName: StoreToken
            query: Query<T>
        }) => QueryResult<T>
        applyChanges: <T extends Entity>(args: {
            storeName: StoreToken
            changes: ReadonlyArray<StoreChange<T>>
            direction: ChangeDirection
            opContext: OperationContext
        }) => Promise<void>
        applyWriteback: <T extends Entity>(args: {
            storeName: StoreToken
            upserts: T[]
            deletes: EntityId[]
            versionUpdates?: Array<{ key: EntityId; version: number }>
        }) => Promise<StoreDelta<T> | null>
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
