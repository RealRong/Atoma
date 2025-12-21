import type { AtomaServerRoute } from '../../config'
import { normalizePath } from '../../http/url'
import type { RouteHandler } from '../../engine/router'
import { handleWithRuntime } from '../../engine/handleWithRuntime'
import type { AtomaServerServices } from '../../services/types'

export function createOpsRoute<Ctx>(args: {
    services: AtomaServerServices<Ctx>
    enabled: boolean
    opsPath: string
}): RouteHandler {
    return {
        id: 'ops',
        match: ({ pathname }) => args.enabled && normalizePath(pathname) === normalizePath(args.opsPath),
        handle: (ctx) => handleWithRuntime<Ctx>({
            incoming: ctx.incoming,
            route: { kind: 'ops' } as AtomaServerRoute,
            method: ctx.method,
            pathname: ctx.pathname,
            initialTraceId: ctx.traceIdHeaderValue,
            initialRequestId: ctx.requestIdHeaderValue,
            createRuntime: args.services.runtime.createRuntime,
            formatTopLevelError: args.services.runtime.formatTopLevelError,
            run: (runtime, phase) => args.services.ops.handle({
                incoming: ctx.incoming,
                method: ctx.method,
                pathname: ctx.pathname,
                runtime,
                phase
            })
        })
    }
}

