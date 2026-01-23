import type { Table } from 'dexie'
import type { BackendEndpointConfig, HttpBackendConfig, StoreBackendState } from '#client/types'
import { createClientArgSchema } from '#client/schemas/createClient/args'
import { Shared } from '#shared'

function makeIndexedDbTableForResource<T extends Record<string, Table<any, string>>>(
    tables: T
): (resource: string) => Table<any, string> {
    return (resource: string) => {
        const tbl = (tables as any)[resource]
        if (tbl) return tbl as Table<any, string>
        throw new Error(`[Atoma] indexedDB: 未知 resource: ${String(resource)}`)
    }
}

function mergeHttpOptions(def: any | undefined, lane: any | undefined): Partial<HttpBackendConfig> {
    if (!def && !lane) return {}
    return {
        ...(def ?? {}),
        ...(lane ?? {})
    }
}

function computeRemoteBackend(options: any): BackendEndpointConfig | undefined {
    const remote = options.remote
    if (!remote) return undefined

    const httpDefaults = options.http

    if (typeof remote === 'string') {
        const url = remote.trim()
        if (!url) return undefined
        const http: HttpBackendConfig = { baseURL: url, ...mergeHttpOptions(httpDefaults, undefined) }
        return { http: http as any } as any
    }

    const url = (typeof remote.url === 'string') ? remote.url.trim() : ''
    if (!url) return undefined

    const http: any = { baseURL: url, ...mergeHttpOptions(httpDefaults, remote.http) }

    const sse = (typeof remote.sse === 'string' && remote.sse.trim()) ? remote.sse.trim() : undefined
    if (sse) {
        http.subscribe = {
            buildUrl: (args2?: { resources?: string[] }) => Shared.url.withResourcesParam(
                Shared.url.resolveUrl(url, sse),
                args2?.resources
            ),
            ...(remote.subscribe?.connect ? { connect: remote.subscribe.connect } : {})
        }
    }

    return { http } as any
}

function computeStoreBackendState(options: any): StoreBackendState {
    const storeConfig = options.store
    const httpDefaults = options.http

    if (storeConfig.type === 'http') {
        const http: HttpBackendConfig = { baseURL: storeConfig.url, ...mergeHttpOptions(httpDefaults, storeConfig.http) }
        return { role: 'remote' as const, backend: { http } }
    }
    if (storeConfig.type === 'indexeddb') {
        return {
            role: 'local' as const,
            backend: { indexeddb: { tableForResource: makeIndexedDbTableForResource(storeConfig.tables) } }
        }
    }
    if (storeConfig.type === 'localServer') {
        const http: HttpBackendConfig = { baseURL: storeConfig.url, ...mergeHttpOptions(httpDefaults, storeConfig.http) }
        return { role: 'local' as const, backend: { http } }
    }
    if (storeConfig.type === 'custom') {
        return { role: storeConfig.role, backend: storeConfig.backend }
    }
    return { role: 'local' as const, backend: { memory: { ...(storeConfig.seed ? { seed: storeConfig.seed } : {}) } } }
}

export const createClientBuildArgsSchema = createClientArgSchema
    .transform((options: any) => {
        const storeBackendState = computeStoreBackendState(options)
        const remoteBackend = computeRemoteBackend(options)

        return {
            ...options,
            storeBackendState,
            remoteBackend
        }
    })
    .transform((options: any, _ctx) => {
        const storeBackendState = options.storeBackendState
        return {
            schema: (options.schema ?? ({} as any)) as any,
            ...(options.dataProcessor ? { dataProcessor: options.dataProcessor as any } : {}),
            storeBackendState,
            ...(options.remoteBackend ? { remoteBackend: options.remoteBackend } : {}),
            ...(typeof options.storeBatch !== 'undefined' ? { storeBatch: options.storeBatch } : {})
        } as any
    })
