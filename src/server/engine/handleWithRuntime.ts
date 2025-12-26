import type { AtomaServerRoute } from '../config'
import type { HandleResult } from '../http/types'
import type { ServerRuntime } from './runtime'
import type { CreateRuntime, FormatTopLevelError } from './types'

export async function handleWithRuntime<Ctx>(args: {
    incoming: any
    route: AtomaServerRoute
    method: string
    pathname: string
    initialTraceId?: string
    initialRequestId?: string
    createRuntime: CreateRuntime<Ctx>
    formatTopLevelError: FormatTopLevelError<Ctx>
    run: (runtime: ServerRuntime<Ctx>) => Promise<HandleResult>
}): Promise<HandleResult> {
    let runtime: ServerRuntime<Ctx>

    try {
        runtime = await args.createRuntime({
            incoming: args.incoming,
            route: args.route,
            initialTraceId: args.initialTraceId,
            initialRequestId: args.initialRequestId
        })
    } catch (err) {
        return args.formatTopLevelError({
            route: args.route,
            traceId: args.initialTraceId,
            requestId: args.initialRequestId,
            error: err
        })
    }

    try {
        if (runtime.hooks?.onRequest) await runtime.hooks.onRequest({ ...runtime.hookArgs, incoming: args.incoming })
        runtime.observabilityContext.emit('server:request', { method: args.method, pathname: args.pathname })
        const result = await args.run(runtime)

        if (runtime.hooks?.onResponse) await runtime.hooks.onResponse({ ...runtime.hookArgs, status: result.status })
        return result
    } catch (err: any) {
        runtime.observabilityContext.emit('server:error', { message: err?.message })
        if (runtime.hooks?.onError) await runtime.hooks.onError({ ...runtime.hookArgs, error: err })

        const formatted = args.formatTopLevelError({
            route: args.route,
            ctx: runtime.ctx,
            requestId: runtime.requestId,
            traceId: runtime.traceId,
            error: err
        })

        if (runtime.hooks?.onResponse) await runtime.hooks.onResponse({ ...runtime.hookArgs, status: formatted.status })
        return formatted
    }
}
