import type { AtomaServerRoute } from '../../config'
import { normalizePath } from '../../http/url'
import type { RouteHandler } from '../../engine/router'
import { handleWithRuntime } from '../../engine/handleWithRuntime'
import type { AtomaServerServices } from '../../services/types'

export function createSyncPushRoute<Ctx>(args: {
    services: AtomaServerServices<Ctx>
    enabled: boolean
    pushPath: string
}): RouteHandler {
    return {
        id: 'sync:push',
        match: ({ pathname }) => args.enabled && normalizePath(pathname) === normalizePath(args.pushPath),
        handle: async (ctx) => {
            const prepared = await args.services.sync.preparePush({
                incoming: ctx.incoming,
                traceIdHeaderValue: ctx.traceIdHeaderValue,
                requestIdHeaderValue: ctx.requestIdHeaderValue
            })

            return handleWithRuntime<Ctx>({
                incoming: ctx.incoming,
                route: { kind: 'sync', name: 'push' } as AtomaServerRoute,
                method: ctx.method,
                pathname: ctx.pathname,
                initialTraceId: prepared.initialTraceId,
                initialRequestId: prepared.initialRequestId,
                createRuntime: args.services.runtime.createRuntime,
                formatTopLevelError: args.services.runtime.formatTopLevelError,
                run: (runtime, phase) => args.services.sync.push({
                    incoming: ctx.incoming,
                    method: ctx.method,
                    pathname: ctx.pathname,
                    route: { kind: 'sync', name: 'push' } as AtomaServerRoute,
                    request: prepared.request,
                    runtime,
                    phase
                })
            })
        }
    }
}
