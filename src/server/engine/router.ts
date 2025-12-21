import { stripBasePath } from '../http/url'
import { Protocol } from '#protocol'
import type { HandleResult } from '../http/types'

export type RouteContext = {
    incoming: any
    urlRaw: string
    urlForParse: string
    urlObj: URL
    pathname: string
    method: string
    traceIdHeaderValue?: string
    requestIdHeaderValue?: string
}

export type RouteHandler = {
    id: string
    match: (ctx: Pick<RouteContext, 'pathname' | 'method'>) => boolean
    handle: (ctx: RouteContext) => Promise<HandleResult>
}

export type RouterMiddleware = (ctx: RouteContext, next: (ctx: RouteContext) => Promise<HandleResult>) => Promise<HandleResult>

export function createRouter(args: {
    basePath?: string
    traceHeader: string
    requestHeader: string
    routes: RouteHandler[]
    middleware?: RouterMiddleware[]
    notFound: () => HandleResult
    onError?: (args: { error: unknown; ctx: RouteContext; routeId?: string }) => HandleResult
}) {
    const { basePath, traceHeader, requestHeader, routes, notFound } = args
    const middleware = Array.isArray(args.middleware) ? args.middleware : []

    return async function handle(incoming: any): Promise<HandleResult> {
        const urlRaw = typeof incoming?.url === 'string' ? incoming.url : '/'
        const urlForParse = basePath ? stripBasePath(urlRaw, basePath) : urlRaw
        if (basePath && urlForParse === undefined) return notFound()

        const urlObj = new URL(urlForParse ?? '/', 'http://localhost')
        const pathname = urlObj.pathname
        const method = (incoming?.method || '').toUpperCase()

        const traceIdHeaderValue = Protocol.trace.parse.getHeader(incoming?.headers, traceHeader)
        const requestIdHeaderValue = Protocol.trace.parse.getHeader(incoming?.headers, requestHeader)

        const ctx: RouteContext = {
            incoming,
            urlRaw,
            urlForParse: urlForParse ?? urlRaw,
            urlObj,
            pathname,
            method,
            traceIdHeaderValue,
            requestIdHeaderValue
        }

        const dispatch = async (dispatchCtx: RouteContext) => {
            for (const r of routes) {
                if (!r.match({ pathname: dispatchCtx.pathname, method: dispatchCtx.method })) continue
                try {
                    return await r.handle(dispatchCtx)
                } catch (error) {
                    if (typeof args.onError === 'function') {
                        return args.onError({ error, ctx: dispatchCtx, routeId: r.id })
                    }
                    throw error
                }
            }

            return notFound()
        }

        type Dispatch = (ctx: RouteContext) => Promise<HandleResult>

        const composed: Dispatch = middleware.reduceRight<Dispatch>(
            (next, mw) => (cur) => mw(cur, next),
            dispatch
        )

        return composed(ctx)
    }
}
