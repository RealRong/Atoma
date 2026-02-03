import type { Query } from '../../protocol'
import type * as Types from '../../core'
import type { CoreRuntime, PersistRequest, PersistResult } from '../../runtime'
import type { OperationEnvelope, ResultEnvelope } from '../drivers/types'
import type { EndpointRegistry, CapabilitiesRegistry } from '../registry'

export type Next<T> = () => Promise<T>

export type IoContext = {
    clientId: string
    endpointId?: string
    storeName?: string
}

export type PersistContext = {
    clientId: string
    store: string
}

export type ReadContext = {
    clientId: string
    store: string
}

export type ObserveContext = {
    clientId: string
}

export type ObserveNext = () => Types.ObservabilityContext

export type ReadRequest = Readonly<{
    storeName: Types.StoreToken
    query: Query
    context?: Types.ObservabilityContext
    signal?: AbortSignal
}>

export type QueryResult = Readonly<{
    data: unknown[]
    pageInfo?: any
    explain?: any
}>

export type ObserveRequest = Readonly<{
    storeName?: Types.StoreToken
    traceId?: string
    explain?: boolean
}>

export type IoHandler = (
    req: OperationEnvelope,
    ctx: IoContext,
    next: Next<ResultEnvelope>
) => Promise<ResultEnvelope>

export type PersistHandler = (
    req: PersistRequest<any>,
    ctx: PersistContext,
    next: Next<PersistResult<any>>
) => Promise<PersistResult<any>>

export type ReadHandler = (
    req: ReadRequest,
    ctx: ReadContext,
    next: Next<QueryResult>
) => Promise<QueryResult>

export type ObserveHandler = (
    req: ObserveRequest,
    ctx: ObserveContext,
    next: ObserveNext
) => Types.ObservabilityContext

export type HandlerMap = {
    io: IoHandler
    persist: PersistHandler
    read: ReadHandler
    observe: ObserveHandler
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
    endpoints: EndpointRegistry
    capabilities: CapabilitiesRegistry
    runtime: CoreRuntime
}>

export type ClientPluginContext = PluginContext
