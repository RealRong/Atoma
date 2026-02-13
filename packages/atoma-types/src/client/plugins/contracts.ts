import type { Patch } from 'immer'
import type { OperationContext as CoreOperationContext, Entity, Query, QueryResult } from '../../core'
import type { Runtime, Hooks } from '../../runtime'
import type { RemoteOperationEnvelope, RemoteOperationResultEnvelope } from '../ops'
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

export type PluginRuntimeApi = Readonly<{
    id: string
    now: () => number
    queryStore: <T extends Entity>(args: {
        storeName: string
        query: Query<T>
    }) => QueryResult<T>
    applyStorePatches: <T extends Entity>(args: {
        storeName: string
        patches: Patch[]
        inversePatches: Patch[]
        opContext: CoreOperationContext
    }) => Promise<void>
}>

export type RuntimeExtensionFacade = Readonly<{
    id: Runtime['id']
    now: Runtime['now']
    stores: Pick<Runtime['stores'], 'resolveHandle'>
    strategy: Pick<Runtime['strategy'], 'register' | 'query' | 'write'>
    transform: Pick<Runtime['transform'], 'writeback'>
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

export type RuntimeExtensionContext = Readonly<PluginContext & {
    runtimeExtension: RuntimeExtensionFacade
}>

export type RuntimeExtensionPlugin<Ext = unknown> = Readonly<{
    id?: string
    runtimeExtension: true
    operations?: (ctx: RuntimeExtensionContext, register: RegisterOperationMiddleware) => void
    events?: (ctx: RuntimeExtensionContext, register: EventRegister) => void
    init?: (ctx: RuntimeExtensionContext) => void | PluginInitResult<Ext>
}>

export type AnyClientPlugin<Ext = unknown> = ClientPlugin<Ext> | RuntimeExtensionPlugin<Ext>

export type PluginContext = Readonly<{
    clientId: string
    capabilities: CapabilitiesRegistry
    runtimeApi: PluginRuntimeApi
    events: PluginEvents
}>
