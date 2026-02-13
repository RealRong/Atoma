import type { Patch } from 'immer'
import type { OperationContext as CoreOperationContext, Entity, Query, QueryResult, StoreToken } from '../../core'
import type { Runtime, Hooks, QueryOutput } from '../../runtime'
import type { OperationClient, RemoteOperationEnvelope, RemoteOperationResultEnvelope } from '../ops'
import type { CapabilitiesRegistry } from '../registry'

export type Next<T> = () => Promise<T>

export type OperationContext = {
    clientId: string
}

export type OperationMiddleware = (
    req: RemoteOperationEnvelope,
    ctx: OperationContext,
    next: Next<RemoteOperationResultEnvelope>
) => Promise<RemoteOperationResultEnvelope>

export type OperationMiddlewareEntry = {
    handler: OperationMiddleware
    priority: number
}

export type RegisterOperationMiddleware = (
    handler: OperationMiddleware,
    opts?: { priority?: number }
) => () => void

export type EventRegister = (hooks: Hooks) => () => void

export type PluginEvents = Readonly<{
    register: EventRegister
}>

export type PluginRuntime = Readonly<{
    id: Runtime['id']
    now: Runtime['now']
    stores: Readonly<{
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
    execution: Readonly<{
        register: Runtime['execution']['register']
        setDefault: Runtime['execution']['setDefault']
        resolvePolicy: Runtime['execution']['resolvePolicy']
        subscribe: Runtime['execution']['subscribe']
        query: <T extends Entity>(args: {
            storeName: StoreToken
            query: Query<T>
            signal?: AbortSignal
        }) => Promise<QueryOutput>
        write: Runtime['execution']['write']
    }>
}>

export type PluginInitResult<Ext = unknown> = Readonly<{
    extension?: Ext
    dispose?: () => void
}>

export type ClientPlugin<Ext = unknown> = Readonly<{
    id?: string
    operations?: (ctx: PluginContext, register: RegisterOperationMiddleware) => void
    events?: (ctx: PluginContext, register: EventRegister) => void
    init?: (ctx: PluginContext) => void | PluginInitResult<Ext>
}>

export type PluginContext = Readonly<{
    clientId: string
    capabilities: CapabilitiesRegistry
    operation: OperationClient
    runtime: PluginRuntime
    events: PluginEvents
}>
