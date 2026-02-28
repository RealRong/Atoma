import type {
    AtomaErrorMiddlewareContext,
    AtomaRouteMiddlewareContext,
    AtomaServerPluginRuntime,
    AtomaServerRoute
} from '../config'
import type { HandleResult } from '../runtime/http'
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
        runRequestMiddlewares: (
            ctx: AtomaRouteMiddlewareContext<Ctx>,
            next: () => Promise<void>
        ) => Promise<void>
        runResponseMiddlewares: (
            ctx: AtomaRouteMiddlewareContext<Ctx>,
            next: () => Promise<Response>
        ) => Promise<Response>
        runErrorMiddlewares: (
            ctx: AtomaErrorMiddlewareContext<Ctx>,
            next: () => Promise<void>
        ) => Promise<void>
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

        const pluginRuntime: AtomaServerPluginRuntime<Ctx> = {
            ctx: runtime.ctx as Ctx,
            traceId: runtime.traceId,
            requestId: runtime.requestId,
            logger: runtime.logger
        }
        const routeContext: AtomaRouteMiddlewareContext<Ctx> = {
            request: input.request,
            route: input.route,
            runtime: pluginRuntime
        }

        try {
            await input.runRequestMiddlewares(routeContext, async () => undefined)

            return await input.runResponseMiddlewares(
                routeContext,
                () => input.run(runtime)
            )
        } catch (err: any) {
            runtime.logger?.error?.('request failed', {
                route: input.route,
                method: input.method,
                pathname: input.pathname,
                error: serializeErrorForLog(err)
            })

            try {
                await input.runErrorMiddlewares({
                    ...routeContext,
                    error: err
                }, async () => undefined)
            } catch (middlewareError) {
                runtime.logger?.error?.('error middleware failed', {
                    route: input.route,
                    method: input.method,
                    pathname: input.pathname,
                    error: serializeErrorForLog(middlewareError),
                    sourceError: serializeErrorForLog(err)
                })
            }

            const response = handleResultToResponse(args.formatTopLevelError({
                route: input.route,
                ctx: runtime.ctx,
                requestId: runtime.requestId,
                traceId: runtime.traceId,
                error: err
            }))

            try {
                return await input.runResponseMiddlewares(routeContext, async () => response)
            } catch (middlewareError) {
                runtime.logger?.error?.('response middleware failed', {
                    route: input.route,
                    method: input.method,
                    pathname: input.pathname,
                    status: response.status,
                    error: serializeErrorForLog(middlewareError),
                    sourceError: serializeErrorForLog(err)
                })
                return response
            }
        }
    }
}
