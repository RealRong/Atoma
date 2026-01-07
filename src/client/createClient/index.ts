import type { Entity } from '#core'
import { createAtomaClientInternal } from '../createAtomaClient'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
    HttpBackendConfig,
    SyncQueueWriteMode
} from '../types'
import {
    assertNoEchoEndpoint,
    mkIdxTblForRes,
    mkSyncTargetFromBackend,
    mergeHttpOv,
    toQWrites,
    toSyncDef
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
    const opt = (typeof arg === 'string'
        ? ({
            store: {
                type: 'http',
                url: arg
            }
        } as unknown as CreateClientOptions<E, S>)
        : arg)

    const store = opt.store
    const httpDef = opt.http

    const storeBackend = (() => {
        if (store.type === 'http') {
            const http: HttpBackendConfig = { baseURL: store.url, ...mergeHttpOv(httpDef, store.http) }
            return { role: 'remote' as const, backend: { http } }
        }
        if (store.type === 'indexeddb') {
            return {
                role: 'local' as const,
                backend: { indexeddb: { tableForResource: mkIdxTblForRes(store.tables) } }
            }
        }
        if (store.type === 'localServer') {
            const http: HttpBackendConfig = { baseURL: store.url, ...mergeHttpOv(httpDef, store.http) }
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
        const backend = (sync.backend
            ?? (sync.url ? (sync.url as any) : undefined)
            ?? (storeBackend.role === 'remote' ? (storeBackend.backend as any) : undefined)) as any
        if (!backend) return undefined

        const ov = mergeHttpOv(httpDef, sync.http)
        return mkSyncTargetFromBackend({
            backend,
            ov,
            sse: sync.sse
        })
    })()

    const syncQueue = (() => {
        if (!sync) return { enabled: false as const }

        const implied = Boolean(
            typeof sync.maxQueueSize === 'number'
            || sync.onQueueChange
            || sync.onQueueFull
        )

        const storeDurableLocal = store.type === 'indexeddb'
            || store.type === 'localServer'
            || (store.type === 'custom' && store.role === 'local')

        const q = sync.queue
        const qEffective = (() => {
            if (q === false) return false
            if (q === 'queue' || q === 'local-first') return q
            if (typeof q === 'undefined') {
                if (implied) return storeDurableLocal ? 'local-first' : 'queue'
                return storeDurableLocal ? 'local-first' : false
            }
            return false
        })()

        if (qEffective === false) return { enabled: false as const }

        const writes = toQWrites({
            maxQueueSize: sync.maxQueueSize,
            onQueueChange: sync.onQueueChange,
            onQueueFull: sync.onQueueFull
        })

        const mode: SyncQueueWriteMode = qEffective === 'local-first' ? 'local-first' : 'intent-only'

        return { enabled: true as const, writes, mode }
    })()

    return createAtomaClientInternal<E, S>({
        schema: (opt.schema ?? ({} as S)) as S,
        storeBackend,
        ...(typeof opt.storeBatch !== 'undefined' ? { storeBatch: opt.storeBatch } : {}),
        ...(syncTarget ? { syncTarget } : {}),
        ...(syncDefaults ? { syncDefaults } : {}),
        ...(syncQueue.enabled ? { syncQueueWrites: (syncQueue.writes ?? {}) } : {}),
        ...(syncQueue.enabled ? { syncQueueWriteMode: syncQueue.mode } : {})
    })
}
