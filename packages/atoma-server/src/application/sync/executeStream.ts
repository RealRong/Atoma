import { sseComment, sseNotify, sseRetry } from 'atoma-types/protocol-tools'
import type { AtomaServerConfig } from '../../config'
import type { HandleResult } from '../../runtime/http'
import { throwError } from '../../error'
import { parseSyncStreamQueryFromUrl } from '../../domain/contracts/syncRxdb'

type StreamRuntime<Ctx> = {
    requestId: string
    traceId?: string
    logger: any
    ctx: Ctx
}

export async function executeApplicationStream<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    incoming: { signal?: AbortSignal } | unknown
    urlObj: URL
    method: string
    runtime: StreamRuntime<Ctx>
}): Promise<HandleResult> {
    if (args.method !== 'GET') {
        throwError('METHOD_NOT_ALLOWED', 'GET required', {
            kind: 'validation',
            traceId: args.runtime.traceId,
            requestId: args.runtime.requestId
        })
    }

    const sync = args.config.adapter.sync
    if (!sync || args.config.sync?.enabled === false) {
        throwError('INVALID_REQUEST', 'Sync adapter is required when sync is enabled', {
            kind: 'validation',
            traceId: args.runtime.traceId,
            requestId: args.runtime.requestId
        })
    }

    const streamConfig = args.config.sync?.stream
    const heartbeatMs = Math.max(0, Math.floor(streamConfig?.heartbeatMs ?? 15_000))
    const retryMs = Math.max(0, Math.floor(streamConfig?.retryMs ?? 2_000))
    const maxHoldMs = Math.max(100, Math.floor(streamConfig?.maxHoldMs ?? 30_000))
    const parsed = parseSyncStreamQueryFromUrl(args.urlObj)
    const cursorByResource = { ...parsed.afterCursorByResource }

    const body = (async function* generate() {
        let lastHeartbeat = Date.now()
        yield sseRetry(retryMs)

        while (true) {
            if ((args.incoming as any)?.signal?.aborted === true) return

            const now = Date.now()
            if (heartbeatMs > 0 && now - lastHeartbeat >= heartbeatMs) {
                lastHeartbeat = now
                yield sseComment('hb')
            }

            const waitTimeout = heartbeatMs > 0
                ? Math.min(maxHoldMs, Math.max(0, heartbeatMs - (Date.now() - lastHeartbeat)))
                : maxHoldMs

            const changes = await sync.waitForResourceChanges({
                resources: parsed.resources,
                afterCursorByResource: cursorByResource,
                timeoutMs: waitTimeout
            })
            if (!changes.length) continue

            for (const change of changes) {
                cursorByResource[change.resource] = change.cursor
                yield sseNotify({
                    resource: change.resource,
                    cursor: change.cursor
                })
            }
        }
    })()

    return {
        status: 200,
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive'
        },
        body
    }
}
