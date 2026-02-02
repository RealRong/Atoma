import type { ObservabilityContext } from 'atoma-observability'
import type { Query } from 'atoma-protocol'
import type { StoreToken } from 'atoma-core'
import type { CoreRuntime } from 'atoma-runtime/types/runtimeTypes'
import type { PersistRequest, PersistResult } from 'atoma-runtime/types/persistenceTypes'
import type { OperationEnvelope, ResultEnvelope } from '../drivers/types'
import type { EndpointRegistry } from '../drivers/EndpointRegistry'

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

export type ObserveNext = () => ObservabilityContext

export type ReadRequest = Readonly<{
    storeName: StoreToken
    query: Query
    context?: ObservabilityContext
    signal?: AbortSignal
}>

export type QueryResult = Readonly<{
    data: unknown[]
    pageInfo?: any
    explain?: any
}>

export type ObserveRequest = Readonly<{
    storeName?: StoreToken
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
) => ObservabilityContext

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

export type PluginContext = Readonly<{
    clientId: string
    endpoints: EndpointRegistry
    runtime: CoreRuntime
}>
