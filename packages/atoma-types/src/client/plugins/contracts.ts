import type { Entity, Query, StoreToken } from '../../core'
import type { Runtime, PersistRequest, PersistResult, HookRegistry } from '../../runtime'
import type { OperationEnvelope, ResultEnvelope } from '../ops'
import type { CapabilitiesRegistry } from '../registry'

export type Next<T> = () => Promise<T>

export type IoContext = {
    clientId: string
    storeName?: StoreToken
}

export type PersistContext = {
    clientId: string
    storeName: StoreToken
}

export type ReadContext = {
    clientId: string
    storeName: StoreToken
}

export type ReadRequest = Readonly<{
    storeName: StoreToken
    query: Query
    signal?: AbortSignal
}>

export type PluginReadResult = Readonly<{
    data: unknown[]
    pageInfo?: unknown
}>

export type IoHandler = (
    req: OperationEnvelope,
    ctx: IoContext,
    next: Next<ResultEnvelope>
) => Promise<ResultEnvelope>

export type PersistHandler = <T extends Entity>(
    req: PersistRequest<T>,
    ctx: PersistContext,
    next: Next<PersistResult<T>>
) => Promise<PersistResult<T>>

export type ReadHandler = (
    req: ReadRequest,
    ctx: ReadContext,
    next: Next<PluginReadResult>
) => Promise<PluginReadResult>

export type HandlerMap = {
    io: IoHandler
    persist: PersistHandler
    read: ReadHandler
}

export type HandlerName = keyof HandlerMap

export type HandlerEntry<K extends HandlerName = HandlerName> = {
    handler: HandlerMap[K]
    priority: number
}

export type Register = <K extends HandlerName>(
    name: K,
    handler: HandlerMap[K],
    opts?: { priority?: number }
) => () => void

export type PluginInitResult<Ext = unknown> = Readonly<{
    extension?: Ext
    dispose?: () => void
}>

export type ClientPlugin<Ext = unknown> = Readonly<{
    id?: string
    register?: (ctx: PluginContext, register: Register) => void
    init?: (ctx: PluginContext) => void | PluginInitResult<Ext>
}>

export type PluginContext = Readonly<{
    clientId: string
    capabilities: CapabilitiesRegistry
    runtime: Runtime
    hooks: HookRegistry
}>
