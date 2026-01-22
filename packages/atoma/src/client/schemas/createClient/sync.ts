import { Shared } from '#shared'
import { anyFunction, nonEmptyString } from '#client/schemas/common'
import { httpEndpointOptionsSchema } from '#client/schemas/createClient/http'
import type { AtomaClientSyncConfig } from '#client/types'
import { wantsPush, wantsSubscribe } from 'atoma-sync'

const { z } = Shared.zod

export const syncModeSchema = z.enum(['pull-only', 'subscribe-only', 'pull+subscribe', 'push-only', 'full'])
export const outboxModeSchema = z.enum(['queue', 'local-first'])

export const syncRetryConfigSchema = z.object({
    maxAttempts: z.number().finite().int().positive().optional()
}).loose()

export const syncBackoffConfigSchema = z.object({
    baseDelayMs: z.number().finite().nonnegative().optional(),
    maxDelayMs: z.number().finite().nonnegative().optional(),
    jitterRatio: z.number().finite().nonnegative().optional()
}).loose()

export const syncOutboxEventsSchema = z.object({
    onQueueChange: anyFunction().optional(),
    onQueueFull: anyFunction().optional()
}).loose()

export const endpointConfigInputSchema = z.union([
    nonEmptyString(),
    z.object({
        url: nonEmptyString(),
        http: httpEndpointOptionsSchema.optional(),
        sse: z.string().optional()
    }).loose()
])

const pullConfigInputSchema = z.object({
    limit: z.number().finite().int().positive().optional(),
    debounceMs: z.number().finite().nonnegative().optional(),
    intervalMs: z.number().finite().nonnegative().optional()
}).loose()

const pushConfigInputSchema = z.object({
    maxItems: z.number().finite().int().positive().optional(),
    returning: z.boolean().optional(),
    conflictStrategy: z.union([
        z.literal('server-wins'),
        z.literal('client-wins'),
        z.literal('reject'),
        z.literal('manual')
    ]).optional()
}).loose()

const subscribeConfigInputSchema = z.object({
    enabled: z.boolean().optional(),
    eventName: z.string().optional(),
    reconnectDelayMs: z.number().finite().nonnegative().optional()
}).loose()

const engineConfigObjectInputSchema = z.object({
    mode: syncModeSchema.optional(),
    resources: z.array(z.string()).optional(),
    initialCursor: z.any().optional(),

    pull: pullConfigInputSchema.optional(),
    push: pushConfigInputSchema.optional(),
    subscribe: subscribeConfigInputSchema.optional(),

    retry: syncRetryConfigSchema.optional(),
    backoff: syncBackoffConfigSchema.optional(),
    now: anyFunction().optional(),

    onError: anyFunction().optional(),
    onEvent: anyFunction().optional()
}).loose()

export const engineConfigInputSchema = z.union([
    syncModeSchema,
    engineConfigObjectInputSchema
])

export const outboxConfigObjectInputSchema = z.object({
    mode: outboxModeSchema.optional(),
    storage: z.object({
        maxSize: z.number().finite().int().positive().optional(),
        inFlightTimeoutMs: z.number().finite().int().nonnegative().optional()
    }).loose().optional(),
    events: syncOutboxEventsSchema.optional()
}).loose()

export const outboxConfigInputSchema = z.union([
    z.literal(false),
    outboxModeSchema,
    outboxConfigObjectInputSchema
])

export const syncStateConfigInputSchema = z.object({
    deviceId: z.string().optional(),
    keys: z.object({
        outbox: z.string().optional(),
        cursor: z.string().optional(),
        lock: z.string().optional()
    }).loose().optional(),
    lock: z.object({
        ttlMs: z.number().finite().positive().optional(),
        renewIntervalMs: z.number().finite().positive().optional()
    }).loose().optional()
}).loose()

/**
 * 对外输入模型（Input）：允许第一层快捷字段，也允许结构化字段。
 * 同一语义来源必须互斥（通过 superRefine 强制）。
 */
export const syncInputSchema = z.object({
    // 第一层快捷字段
    url: nonEmptyString().optional(),
    sse: z.string().optional(),
    mode: syncModeSchema.optional(),
    outbox: outboxConfigInputSchema.optional(),

    // 结构化字段
    endpoint: endpointConfigInputSchema.optional(),
    engine: engineConfigInputSchema.optional(),
    state: syncStateConfigInputSchema.optional()
})
    .loose()
    .superRefine((value, ctx) => {
        if (value.endpoint !== undefined && (value.url !== undefined || value.sse !== undefined)) {
            ctx.addIssue({
                code: 'custom',
                message: 'sync.endpoint 与 sync.url/sync.sse 互斥（请二选一）'
            })
        }
        if (value.engine !== undefined && value.mode !== undefined) {
            ctx.addIssue({
                code: 'custom',
                message: 'sync.engine 与 sync.mode 互斥（请二选一）'
            })
        }
    })

const SYNC_INSTANCE_ID_SESSION_KEY = 'atoma:sync:instanceId'

function createSyncInstanceId(): string {
    const cryptoAny = typeof crypto !== 'undefined' ? (crypto as any) : undefined
    const uuid = cryptoAny?.randomUUID?.()
    if (typeof uuid === 'string' && uuid) return `i_${uuid}`
    return `i_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
}

const resolveSyncInstanceId = (() => {
    let fallback: string | undefined

    const safeFallback = () => {
        if (!fallback) fallback = createSyncInstanceId()
        return fallback
    }

    return (): string => {
        if (typeof window === 'undefined') return safeFallback()

        let storage: Storage | undefined
        try {
            storage = window.sessionStorage
        } catch {
            storage = undefined
        }
        if (!storage) return safeFallback()

        try {
            const existing = storage.getItem(SYNC_INSTANCE_ID_SESSION_KEY)
            if (existing && existing.trim()) return existing.trim()
            const next = createSyncInstanceId()
            storage.setItem(SYNC_INSTANCE_ID_SESSION_KEY, next)
            return next
        } catch {
            return safeFallback()
        }
    }
})()

function resolveEndpointInput(sync: any): { url: string; http?: any; sse?: string } | undefined {
    if (!sync) return undefined

    if (sync.endpoint !== undefined) {
        if (typeof sync.endpoint === 'string') {
            return { url: String(sync.endpoint) }
        }
        if (sync.endpoint && typeof sync.endpoint === 'object') {
            return {
                url: String(sync.endpoint.url),
                http: sync.endpoint.http,
                sse: sync.endpoint.sse
            }
        }
        return undefined
    }

    if (sync.url !== undefined) {
        return {
            url: String(sync.url),
            sse: sync.sse
        }
    }

    return undefined
}

function resolveEngineInput(sync: any): any {
    if (!sync) return {}
    if (sync.engine !== undefined) {
        if (typeof sync.engine === 'string') return { mode: sync.engine }
        if (sync.engine && typeof sync.engine === 'object') return sync.engine
    }
    return {}
}

function resolveModeInput(sync: any, engine: any): string {
    const modeFromEngine = engine?.mode
    if (typeof modeFromEngine === 'string' && modeFromEngine) return modeFromEngine
    if (typeof sync?.mode === 'string' && sync.mode) return String(sync.mode)
    return 'full'
}

function resolveOutboxInput(sync: any): any {
    return sync?.outbox
}

export const syncResolvedConfigSchema = z.object({
    sync: syncInputSchema.optional(),
    httpDefaults: httpEndpointOptionsSchema.optional(),
    storeDurableLocal: z.boolean()
})
    .loose()
    .superRefine((value, ctx) => {
        const sync = value.sync
        if (!sync) return

        const endpointInput = resolveEndpointInput(sync)
        if (!endpointInput?.url || !String(endpointInput.url).trim()) {
            ctx.addIssue({
                code: 'custom',
                message: '使用 sync 配置时必须提供 sync.url 或 sync.endpoint'
            })
            return
        }

        const engine = resolveEngineInput(sync)
        const mode = resolveModeInput(sync, engine)

        const subscribeCfg = (engine && typeof engine === 'object') ? engine.subscribe : undefined
        const subscribeEnabled = subscribeCfg?.enabled !== false

        if (wantsSubscribe(mode) && subscribeEnabled) {
            const sse = endpointInput.sse ?? sync.sse
            if (!sse || !String(sse).trim()) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'subscribe 模式需要配置 SSE：请提供 sync.sse 或 sync.endpoint.sse'
                })
            }
        }

        const outboxInput = resolveOutboxInput(sync)
        if (wantsPush(mode) && outboxInput === false) {
            ctx.addIssue({
                code: 'custom',
                message: 'push 模式需要启用 outbox（sync.outbox 不能为 false）'
            })
        }
    })
    .transform((value): AtomaClientSyncConfig | undefined => {
        const syncInput = value.sync
        if (!syncInput) return undefined

        const endpointInput = resolveEndpointInput(syncInput)!
        const url = String(endpointInput.url).trim()
        const endpointKey = Shared.url.normalizeBaseUrl(url) || url

        const httpMerged = {
            ...(value.httpDefaults ?? {}),
            ...(endpointInput.http ?? {})
        }
        const hasHttp = Object.keys(httpMerged).length > 0

        const endpoint = {
            url,
            ...(hasHttp ? { http: httpMerged } : {}),
            ...(endpointInput.sse ? { sse: String(endpointInput.sse) } : (syncInput.sse ? { sse: String(syncInput.sse) } : {}))
        }

        const engineIn = resolveEngineInput(syncInput)
        const mode = resolveModeInput(syncInput, engineIn)

        const pullIn = engineIn?.pull ?? {}
        const pushIn = engineIn?.push ?? {}
        const subIn = engineIn?.subscribe ?? {}

        const engine = {
            mode,
            ...(engineIn?.resources ? { resources: engineIn.resources } : {}),
            ...(engineIn?.initialCursor ? { initialCursor: engineIn.initialCursor } : {}),
            pull: {
                limit: typeof pullIn.limit === 'number' ? pullIn.limit : 200,
                debounceMs: typeof pullIn.debounceMs === 'number' ? pullIn.debounceMs : 200,
                intervalMs: typeof pullIn.intervalMs === 'number' ? pullIn.intervalMs : 30_000
            },
            push: {
                maxItems: typeof pushIn.maxItems === 'number' ? pushIn.maxItems : 50,
                returning: pushIn.returning !== false,
                ...(pushIn.conflictStrategy ? { conflictStrategy: pushIn.conflictStrategy } : {})
            },
            subscribe: {
                enabled: subIn.enabled !== false,
                ...(subIn.eventName ? { eventName: subIn.eventName } : {}),
                reconnectDelayMs: typeof subIn.reconnectDelayMs === 'number' ? subIn.reconnectDelayMs : 1000
            },
            retry: engineIn?.retry ?? { maxAttempts: 10 },
            backoff: engineIn?.backoff ?? {},
            ...(engineIn?.now ? { now: engineIn.now } : {}),
            ...(engineIn?.onError ? { onError: engineIn.onError } : {}),
            ...(engineIn?.onEvent ? { onEvent: engineIn.onEvent } : {})
        }

        const outboxIn = resolveOutboxInput(syncInput)
        const derivedMode = value.storeDurableLocal ? 'local-first' : 'queue'
        const outbox = (() => {
            if (outboxIn === false) return false

        const needs = wantsPush(mode)
        const enabledByDefault = needs

            if (outboxIn === undefined) {
                if (!enabledByDefault) return false
                return {
                    mode: derivedMode,
                    storage: { maxSize: 1000, inFlightTimeoutMs: 30_000 }
                }
            }

            if (typeof outboxIn === 'string') {
                return {
                    mode: outboxIn === 'local-first' ? 'local-first' : 'queue',
                    storage: { maxSize: 1000, inFlightTimeoutMs: 30_000 }
                }
            }

            const modeIn = outboxIn?.mode
            const storageIn = outboxIn?.storage ?? {}
            const modeResolved = modeIn ? (modeIn === 'local-first' ? 'local-first' : 'queue') : derivedMode

            return {
                mode: modeResolved,
                storage: {
                    maxSize: typeof storageIn.maxSize === 'number' ? storageIn.maxSize : 1000,
                    inFlightTimeoutMs: typeof storageIn.inFlightTimeoutMs === 'number' ? storageIn.inFlightTimeoutMs : 30_000
                },
                ...(outboxIn?.events ? { events: outboxIn.events } : {})
            }
        })()

        const stateIn = syncInput.state ?? {}
        const deviceId = (stateIn.deviceId && String(stateIn.deviceId).trim())
            ? String(stateIn.deviceId).trim()
            : resolveSyncInstanceId()

        // Breaking change: outbox storage model is rebuilt (no longer stores prebuilt protocol ops).
        // Bump the key to avoid reading old persisted entries.
        const baseOutboxKey = `atoma:sync:${endpointKey}:${deviceId}:outbox:v2`
        const baseCursorKey = `atoma:sync:${endpointKey}:${deviceId}:cursor`
        const baseLockKey = `${baseOutboxKey}:lock`

        const keysIn = stateIn.keys ?? {}
        const keyOr = (v: any, fallback: string) => (typeof v === 'string' && v.trim()) ? v.trim() : fallback

        const state = {
            deviceId,
            keys: {
                outbox: keyOr(keysIn.outbox, baseOutboxKey),
                cursor: keyOr(keysIn.cursor, baseCursorKey),
                lock: keyOr(keysIn.lock, baseLockKey)
            },
            lock: {
                ...(stateIn.lock?.ttlMs ? { ttlMs: stateIn.lock.ttlMs } : {}),
                ...(stateIn.lock?.renewIntervalMs ? { renewIntervalMs: stateIn.lock.renewIntervalMs } : {})
            }
        }

        return {
            endpoint,
            engine,
            outbox,
            state
        } as any
    })
