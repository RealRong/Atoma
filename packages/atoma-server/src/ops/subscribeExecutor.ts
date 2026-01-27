import { throwError } from '../error'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { ServerRuntime } from '../runtime/createRuntime'
import type { HandleResult } from '../runtime/http'
import { Protocol } from 'atoma/protocol'

function parseResourcesQuery(urlObj: URL): string[] | undefined {
    const values = urlObj.searchParams.getAll('resources')
    const raw = values.length ? values : [urlObj.searchParams.get('resources')].filter(Boolean) as string[]
    if (!raw.length) return undefined
    const out: string[] = []
    raw.forEach(v => {
        String(v)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .forEach(s => out.push(s))
    })
    return out.length ? out : undefined
}

export type SubscribeExecutor<Ctx> = {
    subscribe: (args: {
        incoming: any
        urlObj: URL
        method: string
        pathname: string
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
    }) => Promise<HandleResult>
}

export function createSubscribeExecutor<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
}): SubscribeExecutor<Ctx> {
    const subscribeStream = async function* stream(args2: {
        incoming: any
        resources?: string[]
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        heartbeatMs: number
        retryMs: number
        maxHoldMs: number
    }) {
        let cursor = await args.config.adapter.sync!.getLatestCursor()
        let lastBeat = Date.now()
        const minNotifyIntervalMs = 100
        let notifyDueAtMs: number | undefined
        const pendingResources = new Set<string>()

        const allow = args2.resources?.length ? new Set(args2.resources) : null

        yield Protocol.sse.format.retry(args2.retryMs)
        yield Protocol.sse.format.notify({})

        while (true) {
            if (args2.incoming?.signal?.aborted === true) return

            const now = Date.now()
            if (args2.heartbeatMs > 0 && now - lastBeat >= args2.heartbeatMs) {
                lastBeat = now
                yield Protocol.sse.format.comment('hb')
            }

            if (notifyDueAtMs !== undefined && pendingResources.size > 0 && now >= notifyDueAtMs) {
                const resources = Array.from(pendingResources)
                pendingResources.clear()
                notifyDueAtMs = undefined
                yield Protocol.sse.format.notify({ resources })
                continue
            }

            const timeUntilHeartbeatMs = args2.heartbeatMs > 0
                ? Math.max(0, args2.heartbeatMs - (now - lastBeat))
                : args2.maxHoldMs
            const timeUntilNotifyMs = notifyDueAtMs !== undefined && pendingResources.size > 0
                ? Math.max(0, notifyDueAtMs - now)
                : args2.maxHoldMs
            const holdMs = Math.max(0, Math.min(args2.maxHoldMs, timeUntilHeartbeatMs, timeUntilNotifyMs))

            const changes = await args.config.adapter.sync!.waitForChanges(cursor, holdMs)
            if (!changes.length) continue

            cursor = changes[changes.length - 1].cursor

            const resources = Array.from(new Set(changes.map((c: any) => String(c.resource || '')).filter(Boolean)))
                .filter(r => !allow || allow.has(r))

            if (!resources.length) continue

            resources.forEach(r => pendingResources.add(r))
            if (notifyDueAtMs === undefined && pendingResources.size > 0) {
                notifyDueAtMs = Date.now() + minNotifyIntervalMs
            }
        }
    }

    return {
        subscribe: async ({ incoming, urlObj, method, route, runtime }) => {
            if (method !== 'GET') {
                throwError('METHOD_NOT_ALLOWED', 'GET required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }
            if (!args.config.adapter.sync) {
                throwError('INVALID_REQUEST', 'Sync adapter is required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }
            const resources = parseResourcesQuery(urlObj)

            const heartbeatMs = args.config.sync?.subscribe?.heartbeatMs ?? 15000
            const retryMs = args.config.sync?.subscribe?.retryMs ?? 2000
            const maxHoldMs = args.config.sync?.subscribe?.maxHoldMs ?? 30000

            const headers = {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive'
            }

            return {
                status: 200,
                headers,
                body: subscribeStream({
                    incoming,
                    resources,
                    route,
                    runtime,
                    heartbeatMs,
                    retryMs,
                    maxHoldMs
                })
            }
        }
    }
}
