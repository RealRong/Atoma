import type { AtomaServerRoute } from '../../config'
import { normalizePath } from '../../http/url'
import type { RouteHandler } from '../../engine/router'
import { handleWithRuntime } from '../../engine/handleWithRuntime'
import type { AtomaServerServices } from '../../services/types'

export function createSyncSubscribeVNextRoute<Ctx>(args: {
    services: AtomaServerServices<Ctx>
    enabled: boolean
    subscribePath: string
}): RouteHandler {
    return {
        id: 'sync:subscribe-vnext',
        match: ({ pathname }) => args.enabled && normalizePath(pathname) === normalizePath(args.subscribePath),
        handle: (ctx) => handleWithRuntime<Ctx>({
            incoming: ctx.incoming,
            route: { kind: 'sync', name: 'subscribe' } as AtomaServerRoute,
            method: ctx.method,
            pathname: ctx.pathname,
            initialTraceId: ctx.traceIdHeaderValue,
            initialRequestId: ctx.requestIdHeaderValue,
            createRuntime: args.services.runtime.createRuntime,
            formatTopLevelError: args.services.runtime.formatTopLevelError,
            run: (runtime, phase) => args.services.sync.subscribeVNext({
                incoming: ctx.incoming,
                urlObj: ctx.urlObj,
                method: ctx.method,
                pathname: ctx.pathname,
                route: { kind: 'sync', name: 'subscribe' } as AtomaServerRoute,
                runtime,
                phase
            })
        })
    }
}

