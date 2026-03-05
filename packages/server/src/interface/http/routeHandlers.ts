import type {
    AtomaErrorMiddlewareContext,
    AtomaOpMiddlewareContext,
    AtomaOpMiddlewareResult,
    AtomaRouteMiddlewareContext,
    AtomaServerMiddleware,
    AtomaServerRoute
} from '../../config'
import { composeMiddleware } from '../../shared/middleware/compose'
import { pickMiddlewareHandlers } from './configNormalization'

type RouteContext<Ctx> = {
    request: Request
    urlObj: URL
    method: string
    runtime: any
}

function resolveQueryValue(urlObj: URL, key: string): string | undefined {
    const value = urlObj.searchParams.get(key)
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized ? normalized : undefined
}

function readRouteRequest(request: Request, withTraceQuery: boolean) {
    const urlObj = new URL(request.url)
    return {
        urlObj,
        pathname: urlObj.pathname,
        method: request.method.toUpperCase(),
        initialTraceId: withTraceQuery ? resolveQueryValue(urlObj, 'traceId') : undefined,
        initialRequestId: withTraceQuery ? resolveQueryValue(urlObj, 'requestId') : undefined
    }
}

export function createMiddlewareRunners<Ctx>(middlewares: AtomaServerMiddleware<Ctx>[]) {
    return {
        opMiddlewares: pickMiddlewareHandlers(middlewares, 'onOp') as Array<(
            ctx: AtomaOpMiddlewareContext<Ctx>,
            next: () => Promise<AtomaOpMiddlewareResult>
        ) => Promise<AtomaOpMiddlewareResult>>,
        runRequestMiddlewares: composeMiddleware<AtomaRouteMiddlewareContext<Ctx>, void>(
            pickMiddlewareHandlers(middlewares, 'onRequest') as Array<(
                ctx: AtomaRouteMiddlewareContext<Ctx>,
                next: () => Promise<void>
            ) => Promise<void>>
        ),
        runResponseMiddlewares: composeMiddleware<AtomaRouteMiddlewareContext<Ctx>, Response>(
            pickMiddlewareHandlers(middlewares, 'onResponse') as Array<(
                ctx: AtomaRouteMiddlewareContext<Ctx>,
                next: () => Promise<Response>
            ) => Promise<Response>>
        ),
        runErrorMiddlewares: composeMiddleware<AtomaErrorMiddlewareContext<Ctx>, void>(
            pickMiddlewareHandlers(middlewares, 'onError') as Array<(
                ctx: AtomaErrorMiddlewareContext<Ctx>,
                next: () => Promise<void>
            ) => Promise<void>>
        )
    }
}

export function createRouteHandler<Ctx>(args: {
    route: AtomaServerRoute
    withTraceQuery: boolean
    runWithRuntime: (args: {
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
    }) => Promise<Response>
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
    runUseCase: (args: RouteContext<Ctx>) => Promise<Response>
}) {
    return async (request: Request): Promise<Response> => {
        const requestInfo = readRouteRequest(request, args.withTraceQuery)
        return args.runWithRuntime({
            request,
            route: args.route,
            method: requestInfo.method,
            pathname: requestInfo.pathname,
            initialTraceId: requestInfo.initialTraceId,
            initialRequestId: requestInfo.initialRequestId,
            runRequestMiddlewares: args.runRequestMiddlewares,
            runResponseMiddlewares: args.runResponseMiddlewares,
            runErrorMiddlewares: args.runErrorMiddlewares,
            run: (runtime) => args.runUseCase({
                request,
                urlObj: requestInfo.urlObj,
                method: requestInfo.method,
                runtime
            })
        })
    }
}
