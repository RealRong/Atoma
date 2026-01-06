import type { Entity } from '#core'
import { createAtomaClientInternal } from '../createAtomaClient'
import type {
    AtomaClient,
    AtomaSchema,
    BackendEndpointConfig,
    HttpBackendConfig,
    CreateClientOptions,
    CreateHttpClientOptions,
    CreateLocalFirstClientOptions,
    SyncQueueWriteMode
} from '../types'
import {
    assertNoEchoEndpoint,
    mkIdxTblForRes,
    mkSyncTargetFromBackend,
    pickHttpOv,
    toQMode,
    toQWrites,
    toSyncDef
} from './normalize'

export function createHttpClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateHttpClientOptions<E, S>): AtomaClient<E, S> {

    const http: HttpBackendConfig = {
        baseURL: opt.url,
        ...pickHttpOv(opt)
    }

    const sync = typeof opt.sync === 'string' ? ({ url: opt.sync } as any) : opt.sync
    const syncDefaults = toSyncDef(sync as any)
    const syncBaseUrl = (sync && typeof (sync as any).url === 'string' && (sync as any).url)
        ? String((sync as any).url)
        : http.baseURL
    const sse = (sync && typeof (sync as any).sse === 'string' && (sync as any).sse)
        ? String((sync as any).sse)
        : (opt.sse ? String(opt.sse) : undefined)

    const syncHttp: HttpBackendConfig = {
        ...http,
        baseURL: syncBaseUrl,
        ...((sync && typeof sync === 'object' && !Array.isArray(sync)) ? pickHttpOv(sync as any) : {})
    }

    const syncTarget = (() => {
        if (sse) return ({ http: { ...syncHttp, subscribePath: sse } } as BackendEndpointConfig)
        if (syncBaseUrl !== http.baseURL) return ({ http: syncHttp } as BackendEndpointConfig)
        return undefined
    })()

    const syncQueueWrites = (() => {
        if (!sync) return undefined

        const q = sync.queue
        if (q === false) return undefined

        const implied = Boolean(
            typeof sync.maxQueueSize === 'number'
            || sync.onQueueChange
            || sync.onQueueFull
        )

        const enabled = q === true
            || q === 'local-first'
            || q === 'intent-only'
            || implied

        if (!enabled) return undefined

        return toQWrites({
            maxQueueSize: sync.maxQueueSize,
            onQueueChange: sync.onQueueChange,
            onQueueFull: sync.onQueueFull
        })
    })()

    const syncQueueWriteMode: SyncQueueWriteMode | undefined = (() => {
        const q = sync?.queue
        if (!q || typeof q === 'boolean') return undefined
        return toQMode(q)
    })()

    return createAtomaClientInternal<E, S>({
        schema: (opt.schema ?? ({} as S)) as S,
        storeBackend: { role: 'remote', backend: { http } },
        ...(syncTarget ? { syncTarget } : {}),
        ...(syncDefaults ? { syncDefaults } : {}),
        ...(syncQueueWrites ? { syncQueueWrites } : {}),
        ...(syncQueueWriteMode ? { syncQueueWriteMode } : {})
    })
}

export function createLocalFirstClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateLocalFirstClientOptions<E, S>): AtomaClient<E, S> {
    const sync = typeof opt.sync === 'string' ? ({ url: opt.sync } as any) : opt.sync

    if (opt.storage.type === 'localServer') {
        assertNoEchoEndpoint({ localServerUrl: opt.storage.url, syncUrl: sync.url })
    }

    const storeBackend = (() => {
        if (opt.storage.type === 'indexeddb') {
            return {
                role: 'local' as const,
                backend: { indexeddb: { tableForResource: mkIdxTblForRes(opt.storage.tables) } }
            }
        }

        const http: HttpBackendConfig = {
            baseURL: opt.storage.url,
            ...pickHttpOv(opt.storage)
        }
        return { role: 'local' as const, backend: { http } }
    })()

    const syncHttp: any = {
        baseURL: sync.url,
        ...pickHttpOv(sync),
        ...(sync.sse ? { subscribePath: sync.sse } : {})
    }

    const syncTarget: BackendEndpointConfig = { http: syncHttp }
    const syncDefaults = toSyncDef(sync)

    const q = sync.queue
    const qEnabled = q !== false
    const qWrites = qEnabled
        ? (toQWrites({
            maxQueueSize: sync.maxQueueSize,
            onQueueChange: sync.onQueueChange,
            onQueueFull: sync.onQueueFull
        }) ?? {})
        : undefined

    const qMode = (q === 'local-first' || q === 'intent-only') ? toQMode(q) : undefined

    return createAtomaClientInternal<E, S>({
        schema: (opt.schema ?? ({} as S)) as S,
        storeBackend,
        syncTarget,
        ...(syncDefaults ? { syncDefaults } : {}),
        ...(qWrites ? { syncQueueWrites: qWrites } : {}),
        ...(qMode ? { syncQueueWriteMode: qMode } : {})
    })
}

export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const store = opt.store

    const storeBackend = (() => {
        if (store.type === 'http') {
            const http: HttpBackendConfig = { baseURL: store.url, ...pickHttpOv(store) }
            return { role: 'remote' as const, backend: { http } }
        }
        if (store.type === 'indexeddb') {
            return {
                role: 'local' as const,
                backend: { indexeddb: { tableForResource: mkIdxTblForRes(store.tables) } }
            }
        }
        if (store.type === 'localServer') {
            const http: HttpBackendConfig = { baseURL: store.url, ...pickHttpOv(store) }
            return { role: 'local' as const, backend: { http } }
        }
        if (store.type === 'custom') {
            return { role: store.role, backend: store.backend }
        }
        return { role: 'local' as const, backend: { memory: { ...(store.seed ? { seed: store.seed } : {}) } } }
    })()

    const sync = typeof opt.sync === 'string' ? ({ url: opt.sync } as any) : opt.sync
    const syncDefaults = toSyncDef(sync as any)

    if (store.type === 'localServer' && sync?.url) {
        assertNoEchoEndpoint({ localServerUrl: store.url, syncUrl: sync.url })
    }

    const syncTarget = (() => {
        if (!sync) return undefined
        const backend = (sync.backend ?? (sync.url ? (sync.url as any) : undefined)) as BackendEndpointConfig | undefined
        if (!backend) return undefined

        const ov = pickHttpOv(sync)
        return mkSyncTargetFromBackend({
            backend,
            ov,
            sse: sync.sse
        })
    })()

    const syncQueueWrites = (() => {
        if (!sync) return undefined

        const q = sync.queue
        if (q === false) return undefined

        const implied = Boolean(
            typeof sync.maxQueueSize === 'number'
            || sync.onQueueChange
            || sync.onQueueFull
        )

        const enabled = q === true
            || q === 'local-first'
            || q === 'intent-only'
            || implied

        if (!enabled) return undefined

        return toQWrites({
            maxQueueSize: sync.maxQueueSize,
            onQueueChange: sync.onQueueChange,
            onQueueFull: sync.onQueueFull
        })
    })()

    const syncQueueWriteMode: SyncQueueWriteMode | undefined = (() => {
        const q = sync?.queue
        if (!q || typeof q === 'boolean') return undefined
        return toQMode(q)
    })()

    return createAtomaClientInternal<E, S>({
        schema: (opt.schema ?? ({} as S)) as S,
        storeBackend,
        ...(typeof opt.storeBatch !== 'undefined' ? { storeBatch: opt.storeBatch } : {}),
        ...(syncTarget ? { syncTarget } : {}),
        ...(syncDefaults ? { syncDefaults } : {}),
        ...(syncQueueWrites ? { syncQueueWrites } : {}),
        ...(syncQueueWriteMode ? { syncQueueWriteMode } : {})
    })
}
