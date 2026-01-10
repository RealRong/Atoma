import type { Entity } from '#core'
import { buildAtomaClient } from './buildClient'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
    HttpBackendConfig,
    SyncQueueMode
} from '../../types'
import {
    assertNoEchoEndpoint,
    makeIndexedDbTableForResource,
    makeSyncEndpointFromBackend,
    mergeHttpOverrides,
    toSyncQueueWrites,
    toSyncDefaults
} from './normalize'

export function createClient<
    const E extends Record<string, Entity>
>(url: string): AtomaClient<E, AtomaSchema<E>>

export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S>

export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(arg: string | CreateClientOptions<E, S>): AtomaClient<E, S> {
    const options = (typeof arg === 'string'
        ? ({
            store: {
                type: 'http',
                url: arg
            }
        } as unknown as CreateClientOptions<E, S>)
        : arg)

    const storeConfig = options.store
    const httpDefaults = options.http

    const storeBackendState = (() => {
        if (storeConfig.type === 'http') {
            const http: HttpBackendConfig = { baseURL: storeConfig.url, ...mergeHttpOverrides(httpDefaults, storeConfig.http) }
            return { role: 'remote' as const, backend: { http } }
        }
        if (storeConfig.type === 'indexeddb') {
            return {
                role: 'local' as const,
                backend: { indexeddb: { tableForResource: makeIndexedDbTableForResource(storeConfig.tables) } }
            }
        }
        if (storeConfig.type === 'localServer') {
            const http: HttpBackendConfig = { baseURL: storeConfig.url, ...mergeHttpOverrides(httpDefaults, storeConfig.http) }
            return { role: 'local' as const, backend: { http } }
        }
        if (storeConfig.type === 'custom') {
            return { role: storeConfig.role, backend: storeConfig.backend }
        }
        return { role: 'local' as const, backend: { memory: { ...(storeConfig.seed ? { seed: storeConfig.seed } : {}) } } }
    })()

    const syncConfig = typeof options.sync === 'string' ? ({ url: options.sync } as any) : options.sync
    const syncDefaults = toSyncDefaults(syncConfig as any)

    if (storeConfig.type === 'localServer' && syncConfig?.url) {
        assertNoEchoEndpoint({ localServerUrl: storeConfig.url, syncUrl: syncConfig.url })
    }

    const syncEndpoint = (() => {
        if (!syncConfig) return undefined
        const backend = (syncConfig.backend
            ?? (syncConfig.url ? (syncConfig.url as any) : undefined)
            ?? (storeBackendState.role === 'remote' ? (storeBackendState.backend as any) : undefined)) as any
        if (!backend) return undefined

        const httpOverrides = mergeHttpOverrides(httpDefaults, syncConfig.http)
        return makeSyncEndpointFromBackend({
            backend,
            httpOverrides,
            sse: syncConfig.sse
        })
    })()

    const syncQueue = (() => {
        if (!syncConfig) return { enabled: false as const }

        const implied = Boolean(
            typeof syncConfig.maxQueueSize === 'number'
            || syncConfig.onQueueChange
            || syncConfig.onQueueFull
        )

        const storeDurableLocal = storeConfig.type === 'indexeddb'
            || storeConfig.type === 'localServer'
            || (storeConfig.type === 'custom' && storeConfig.role === 'local')

        const queueModeInput = syncConfig.queue
        const queueModeEffective = (() => {
            if (queueModeInput === false) return false
            if (queueModeInput === 'queue' || queueModeInput === 'local-first') return queueModeInput
            if (typeof queueModeInput === 'undefined') {
                if (implied) return storeDurableLocal ? 'local-first' : 'queue'
                return storeDurableLocal ? 'local-first' : false
            }
            return false
        })()

        if (queueModeEffective === false) return { enabled: false as const }

        const writes = toSyncQueueWrites({
            maxQueueSize: syncConfig.maxQueueSize,
            onQueueChange: syncConfig.onQueueChange,
            onQueueFull: syncConfig.onQueueFull
        })

        const queue: SyncQueueMode = queueModeEffective === 'local-first' ? 'local-first' : 'queue'

        return { enabled: true as const, writes, queue }
    })()

    return buildAtomaClient<E, S>({
        schema: (options.schema ?? ({} as S)) as S,
        storeBackendState,
        ...(typeof options.storeBatch !== 'undefined' ? { storeBatch: options.storeBatch } : {}),
        ...(syncEndpoint ? { syncEndpoint } : {}),
        ...(syncDefaults ? { syncDefaults } : {}),
        ...(syncQueue.enabled ? { syncQueueWrites: (syncQueue.writes ?? {}) } : {}),
        ...(syncQueue.enabled ? { syncQueueMode: syncQueue.queue } : {})
    })
}
