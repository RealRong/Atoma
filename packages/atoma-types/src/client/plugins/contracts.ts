import type { Patch } from 'immer'
import type { OperationContext as CoreOperationContext, Entity, Query, QueryResult, StoreToken, ExecutionRoute } from '../../core'
import type { Runtime, StoreEvents, QueryOutput, StoreHandle } from '../../runtime'
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
        resolveHandle: <T extends Entity>(args: {
            storeName: StoreToken
            reason: string
        }) => StoreHandle<T>
        query: <T extends Entity>(args: {
            storeName: StoreToken
            query: Query<T>
        }) => QueryResult<T>
        applyPatches: <T extends Entity>(args: {
            storeName: StoreToken
            patches: Patch[]
            inversePatches: Patch[]
            opContext: CoreOperationContext
        }) => Promise<void>
        applyWriteback: <T extends Entity>(args: {
            storeName: StoreToken
            upserts: T[]
            deletes: string[]
            versionUpdates?: Array<{ key: string; version: number }>
        }) => Promise<void>
    }>
    debug: Runtime['debug']
    execution: Readonly<{
        apply: Runtime['execution']['apply']
        subscribe: Runtime['execution']['subscribe']
        query: <T extends Entity>(args: {
            storeName: StoreToken
            route?: ExecutionRoute
            query: Query<T>
            signal?: AbortSignal
        }) => Promise<QueryOutput>
        write: Runtime['execution']['write']
    }>
    engine: Readonly<{
        query: Readonly<{
            evaluate: Runtime['engine']['query']['evaluate']
        }>
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
