import { Protocol } from '#protocol'
import { allowOnlyFields } from './authz/helpers'
import type { AtomaServerConfig } from './config'
import type { HandleResult } from './http/types'
import { createRouter } from './engine/router'
import { createRuntimeFactory } from './engine/runtime'
import { createTopLevelErrorFormatter } from './engine/errors'
import { createServerServices } from './services/createServerServices'
import { createDefaultRoutesPlugin } from './plugins/defaultRoutesPlugin'

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

    const userPlugins = Array.isArray(config.plugins) ? config.plugins : []
    const plugins = [...userPlugins, createDefaultRoutesPlugin<Ctx>()]

    const nameSet = new Set<string>()
    for (const p of plugins) {
        if (!p?.name) throw new Error('ServerPlugin.name is required')
        if (nameSet.has(p.name)) throw new Error(`Duplicate ServerPlugin name: ${p.name}`)
        nameSet.add(p.name)
    }

    const pluginArgs = {
        config,
        services,
        routing: {
            opsPath,
            syncEnabled,
            syncSubscribeVNextPath
        }
    } as const

    const setups = plugins.map(p => p.setup(pluginArgs))
    const routes = setups.flatMap(s => Array.isArray(s?.routes) ? s.routes : [])
    const middleware = setups.flatMap(s => Array.isArray(s?.middleware) ? s.middleware : [])

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
        middleware
    })

    return router
}

export const authzHelpers = {
    allowOnlyFields
}
