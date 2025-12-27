import { Protocol } from '#protocol'
import { allowOnlyFields } from './authz/helpers'
import type { AtomaServerConfig } from './config'
import type { HandleResult } from './http/types'
import { normalizePath } from './http/url'
import { createRouter } from './engine/router'
import { createRuntimeFactory } from './engine/runtime'
import { createTopLevelErrorFormatter } from './engine/errors'
import { createServerServices } from './services/createServerServices'
import { handleWithRuntime } from './engine/handleWithRuntime'
import type { RouteHandler } from './engine/router'

const DEFAULT_OPS_PATH = '/ops'
const DEFAULT_SYNC_SUBSCRIBE_VNEXT_PATH = '/sync/subscribe-vnext'

function notFound(): HandleResult {
    return {
        status: 404,
        body: Protocol.ops.compose.error(
            { code: 'NOT_FOUND', message: 'No route matched', kind: 'not_found' },
            { v: 1, serverTimeMs: Date.now() }
        )
    }
}

export function createAtomaServer<Ctx = unknown>(config: AtomaServerConfig<Ctx>) {
    if (!config?.adapter?.orm) {
        throw new Error('AtomaServerConfig.adapter.orm is required')
    }

    const syncEnabled = config.sync?.enabled ?? (config.routing?.sync?.enabled ?? true)
    if (syncEnabled && !config?.adapter?.sync) {
        throw new Error('AtomaServerConfig.adapter.sync is required when sync is enabled')
    }
    if (syncEnabled && typeof (config.adapter.orm as any)?.transaction !== 'function') {
        throw new Error('AtomaServerConfig.adapter.orm.transaction is required when sync is enabled')
    }

    const traceHeader = config.observability?.trace?.traceIdHeader ?? Protocol.trace.headers.TRACE_ID_HEADER
    const requestHeader = config.observability?.trace?.requestIdHeader ?? Protocol.trace.headers.REQUEST_ID_HEADER

    const opsPath = config.routing?.ops?.path ?? DEFAULT_OPS_PATH
    const basePath = config.routing?.basePath

    const syncSubscribeVNextPath = config.routing?.sync?.subscribeVNextPath ?? DEFAULT_SYNC_SUBSCRIBE_VNEXT_PATH

    const formatTopLevelError = createTopLevelErrorFormatter(config)
    const createRuntime = createRuntimeFactory({ config })
    const services = createServerServices({
        config,
        runtime: { createRuntime, formatTopLevelError },
        routing: { syncEnabled }
    })

    const routes: RouteHandler[] = [
        {
            id: 'sync:subscribe-vnext',
            match: ({ pathname }) => syncEnabled && normalizePath(pathname) === normalizePath(syncSubscribeVNextPath),
            handle: (ctx) => handleWithRuntime<Ctx>({
                incoming: ctx.incoming,
                route: { kind: 'sync', name: 'subscribe' },
                method: ctx.method,
                pathname: ctx.pathname,
                initialTraceId: (() => {
                    const q = ctx.urlObj.searchParams.get('traceId')
                    if (typeof q === 'string' && q) return q
                    return ctx.traceIdHeaderValue
                })(),
                initialRequestId: (() => {
                    const q = ctx.urlObj.searchParams.get('requestId')
                    if (typeof q === 'string' && q) return q
                    return ctx.requestIdHeaderValue
                })(),
                createRuntime: services.runtime.createRuntime,
                formatTopLevelError: services.runtime.formatTopLevelError,
                run: (runtime) => services.sync.subscribeVNext({
                    incoming: ctx.incoming,
                    urlObj: ctx.urlObj,
                    method: ctx.method,
                    pathname: ctx.pathname,
                    route: { kind: 'sync', name: 'subscribe' },
                    runtime
                })
            })
        },
        {
            id: 'ops',
            match: ({ pathname }) => normalizePath(pathname) === normalizePath(opsPath),
            handle: (ctx) => handleWithRuntime<Ctx>({
                incoming: ctx.incoming,
                route: { kind: 'ops' },
                method: ctx.method,
                pathname: ctx.pathname,
                initialTraceId: ctx.traceIdHeaderValue,
                initialRequestId: ctx.requestIdHeaderValue,
                createRuntime: services.runtime.createRuntime,
                formatTopLevelError: services.runtime.formatTopLevelError,
                run: (runtime) => services.ops.handle({
                    incoming: ctx.incoming,
                    method: ctx.method,
                    pathname: ctx.pathname,
                    runtime
                })
            })
        }
    ]

    const router = createRouter({
        basePath,
        traceHeader,
        requestHeader,
        notFound,
        onError: ({ error, ctx }) => formatTopLevelError({
            traceId: ctx.traceIdHeaderValue,
            requestId: ctx.requestIdHeaderValue,
            error
        }),
        routes,
    })

    return router
}

export const authzHelpers = {
    allowOnlyFields
}
