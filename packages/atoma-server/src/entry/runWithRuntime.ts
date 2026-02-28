import type { AtomaServerRoute } from '../config'
import type { HandleResult } from '../runtime/http'
import type { PluginRuntime } from './pluginChain'
import { invokeOnErrorSafely, invokeOnResponseSafely } from './hooks'
import { handleResultToResponse, serializeErrorForLog } from './response'

export function createRuntimeRunner<Ctx>(args: {
    createRuntime: (args: {
        incoming: any
        route: AtomaServerRoute
        initialTraceId?: string
        initialRequestId?: string
    }) => Promise<any>
    formatTopLevelError: (args: {
        route?: AtomaServerRoute
        ctx?: Ctx
        requestId?: string
        traceId?: string
        error: unknown
    }) => HandleResult
}) {
    return async (input: {
        request: Request
        route: AtomaServerRoute
        method: string
        pathname: string
        initialTraceId?: string
        initialRequestId?: string
        runResponsePlugins: (ctx: any, next: () => Promise<Response>) => Promise<Response>
        run: (runtime: any) => Promise<Response>
    }): Promise<Response> => {
        let runtime: any

        try {
            runtime = await args.createRuntime({
                incoming: input.request,
                route: input.route,
                initialTraceId: input.initialTraceId,
                initialRequestId: input.initialRequestId
            })
        } catch (err) {
            return handleResultToResponse(args.formatTopLevelError({
                route: input.route,
                traceId: input.initialTraceId,
                requestId: input.initialRequestId,
                error: err
            }))
        }

        const pluginRuntime: PluginRuntime<Ctx> = {
            ctx: runtime.ctx as Ctx,
            traceId: runtime.traceId,
            requestId: runtime.requestId,
            logger: runtime.logger
        }

        try {
            if (runtime.hooks?.onRequest) await runtime.hooks.onRequest({ ...runtime.hookArgs, incoming: input.request })

            const response = await input.runResponsePlugins(
                { request: input.request, route: input.route, runtime: pluginRuntime },
                () => input.run(runtime)
            )

            await invokeOnResponseSafely({
                runtime,
                route: input.route,
                method: input.method,
                pathname: input.pathname,
                status: response.status
            })
            return response
        } catch (err: any) {
            runtime.logger?.error?.('request failed', {
                route: input.route,
                method: input.method,
                pathname: input.pathname,
                error: serializeErrorForLog(err)
            })
            await invokeOnErrorSafely({
                runtime,
                route: input.route,
                method: input.method,
                pathname: input.pathname,
                error: err
            })

            const formatted = args.formatTopLevelError({
                route: input.route,
                ctx: runtime.ctx,
                requestId: runtime.requestId,
                traceId: runtime.traceId,
                error: err
            })
            const response = handleResultToResponse(formatted)
            await invokeOnResponseSafely({
                runtime,
                route: input.route,
                method: input.method,
                pathname: input.pathname,
                status: response.status
            })
            return response
        }
    }
}
