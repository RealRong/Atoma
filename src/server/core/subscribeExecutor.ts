import { throwError } from '../error'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { ServerRuntime } from '../runtime/createRuntime'
import type { HandleResult } from '../runtime/http'
import { Protocol } from '#protocol'

function validateSyncSubscribeQuery(args: { cursor: any }): { cursor: number } {
    const cursorRaw = args.cursor
    const cursor = (() => {
        if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') return 0
        const n = Number(cursorRaw)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(cursor)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation', path: 'cursor' })
    }
    return { cursor }
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
        startCursor: number
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        heartbeatMs: number
        retryMs: number
        maxHoldMs: number
    }) {
        let cursor = args2.startCursor
        let lastBeat = Date.now()

        yield Protocol.sse.format.retry(args2.retryMs)

        while (true) {
            if (args2.incoming?.signal?.aborted === true) return

            const now = Date.now()
            if (now - lastBeat >= args2.heartbeatMs) {
                lastBeat = now
                yield Protocol.sse.format.comment('hb')
            }

            const changes = await args.config.adapter.sync!.waitForChanges(cursor, args2.maxHoldMs)
            if (!changes.length) continue

            const nextCursor = changes[changes.length - 1].cursor
            cursor = nextCursor

            yield Protocol.sse.format.changes({
                nextCursor: String(nextCursor),
                changes: changes.map((c: any) => ({
                    resource: c.resource,
                    entityId: c.id,
                    kind: c.kind,
                    version: c.serverVersion,
                    changedAtMs: c.changedAt
                }))
            })
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

            const { cursor: startCursor } = validateSyncSubscribeQuery({
                cursor: urlObj.searchParams.get('cursor')
            })

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
                    startCursor,
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
