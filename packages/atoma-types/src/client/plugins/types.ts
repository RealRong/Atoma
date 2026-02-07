import type { Query } from '../../core'
import type * as Types from '../../core'
import type { CoreRuntime, PersistRequest, PersistResult, RuntimeHookRegistry } from '../../runtime'
import type { OperationEnvelope, ResultEnvelope } from '../drivers/types'
import type { CapabilitiesRegistry } from '../registry'

export type Next<T> = () => Promise<T>

export type IoContext = {
    clientId: string
    storeName?: string
}

export type PersistContext = {
    clientId: string
    storeName: string
}

export type ReadContext = {
    clientId: string
    storeName: string
}

export type ReadRequest = Readonly<{
    storeName: Types.StoreToken
    query: Query
    signal?: AbortSignal
}>

export type QueryResult = Readonly<{
    data: unknown[]
    pageInfo?: any
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
    runtime: CoreRuntime
    hooks: RuntimeHookRegistry
}>

export type ClientPluginContext = PluginContext
