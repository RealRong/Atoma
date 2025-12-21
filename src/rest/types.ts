import type { FindManyOptions, PageInfo, StoreKey } from '../core/types'
import type { ObservabilityContext } from '#observability'
import type {
    VNextEnvelope,
    VNextMeta,
    VNextOperationResult,
    VNextQueryResultData,
    VNextWriteItem,
    VNextWriteResultData,
    VNextJsonPatch,
    VNextVersion
} from '#protocol'

export type RestTransportMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RestTransportArgs = {
    url: string
    endpoint: string
    method: RestTransportMethod
    body?: unknown
    signal?: AbortSignal
    context?: ObservabilityContext
}

export interface RestTransport {
    execute<T>(args: RestTransportArgs): Promise<VNextEnvelope<T>>
}

export interface RestEndpoints {
    getOne?: string | ((id: StoreKey) => string)
    getAll?: string | (() => string)
    create?: string | (() => string)
    update?: string | ((id: StoreKey) => string)
    delete?: string | ((id: StoreKey) => string)
    patch?: string | ((id: StoreKey) => string)
}

export interface QuerySerializer {
    serialize: <T>(options: FindManyOptions<T>) => URLSearchParams | object
    deserialize?: (params: URLSearchParams) => FindManyOptions<unknown>
}

export type RestEngineConfig = {
    baseURL: string
    endpoints: RestEndpoints
    transport: RestTransport
    querySerializer?: QuerySerializer
    onError?: (error: Error, context: RestErrorContext) => void
}

export type RestErrorAction = 'query' | 'get' | 'create' | 'update' | 'patch' | 'delete'

export type RestErrorContext = {
    action: RestErrorAction
    resource: string
    endpoint?: string
}

export type RestQueryArgs<T> = {
    resource: string
    params?: FindManyOptions<T>
    signal?: AbortSignal
    context?: ObservabilityContext
}

export type RestQueryResult<T> = {
    data: T[]
    pageInfo?: PageInfo
    meta: VNextMeta
    result: VNextOperationResult<VNextQueryResultData>
}

type RestWriteCommon = {
    resource: string
    meta?: VNextWriteItem['meta']
    signal?: AbortSignal
    context?: ObservabilityContext
}

export type RestCreateArgs<T> = RestWriteCommon & {
    value: T
    entityId?: StoreKey
}

export type RestUpdateArgs<T> = RestWriteCommon & {
    entityId: StoreKey
    value: T
    baseVersion?: VNextVersion
}

export type RestPatchArgs = RestWriteCommon & {
    entityId: StoreKey
    patch: VNextJsonPatch[]
    baseVersion: VNextVersion
}

export type RestDeleteArgs = RestWriteCommon & {
    entityId: StoreKey
    baseVersion?: VNextVersion
}

export type RestWriteResult = {
    data: VNextWriteResultData
    meta: VNextMeta
    result: VNextOperationResult<VNextWriteResultData>
}
