import type { AtomaServerRoute } from '../../config'
import { normalizePath } from '../../http/url'
import type { RouteHandler } from '../../engine/router'
import { handleWithRuntime } from '../../engine/handleWithRuntime'
import type { AtomaServerServices } from '../../services/types'

export function createSyncPullRoute<Ctx>(args: {
    services: AtomaServerServices<Ctx>
    enabled: boolean
    pullPath: string
}): RouteHandler {
    return {
        id: 'sync:pull',
        match: ({ pathname }) => args.enabled && normalizePath(pathname) === normalizePath(args.pullPath),
        handle: (ctx) => handleWithRuntime<Ctx>({
            incoming: ctx.incoming,
            route: { kind: 'sync', name: 'pull' } as AtomaServerRoute,
            method: ctx.method,
            pathname: ctx.pathname,
            initialTraceId: ctx.traceIdHeaderValue,
            initialRequestId: ctx.requestIdHeaderValue,
            createRuntime: args.services.runtime.createRuntime,
            formatTopLevelError: args.services.runtime.formatTopLevelError,
            run: (runtime, phase) => args.services.sync.pull({
                urlObj: ctx.urlObj,
                method: ctx.method,
                pathname: ctx.pathname,
                route: { kind: 'sync', name: 'pull' } as AtomaServerRoute,
                runtime,
                phase
            })
        })
    }
}
