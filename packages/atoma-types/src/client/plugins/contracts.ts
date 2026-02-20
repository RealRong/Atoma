import type {
    ActionContext,
    Entity,
    StoreToken
} from '../../core'
import type { Runtime, StoreEvents, StoreSession } from '../../runtime'
import type { ServiceRegistry, ServiceToken } from '../services'

export type PluginEvents = Readonly<{
    register: (events: StoreEvents) => () => void
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
        use: <T extends Entity = Entity>(storeName: StoreToken) => StoreSession<T>
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
