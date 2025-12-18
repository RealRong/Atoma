import { createRequestIdSequencer } from '../observability/trace'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../protocol/trace'
import { allowOnlyFields } from './authz/helpers'
import type { AtomaServerConfig } from './config'
import type { HandleResult } from './http/types'
import { createRouter } from './engine/router'
import { createRuntimeFactory } from './engine/runtime'
import { createTopLevelErrorFormatter } from './engine/errors'
import { createServerServices } from './services/createServerServices'
import { createDefaultRoutesPlugin } from './plugins/defaultRoutesPlugin'

const DEFAULT_BATCH_PATH = '/batch'
const DEFAULT_SYNC_PUSH_PATH = '/sync/push'
const DEFAULT_SYNC_PULL_PATH = '/sync/pull'
const DEFAULT_SYNC_SUBSCRIBE_PATH = '/sync/subscribe'

function notFound(): HandleResult {
    return {
        status: 404,
        body: {
            error: {
                code: 'NOT_FOUND',
                message: 'No route matched'
            }
        }
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

    const traceHeader = config.observability?.trace?.traceIdHeader ?? TRACE_ID_HEADER
    const requestHeader = config.observability?.trace?.requestIdHeader ?? REQUEST_ID_HEADER
    const requestIdSequencer = config.observability?.trace?.requestIdSequencer ?? createRequestIdSequencer()

    const restEnabled = config.routing?.rest?.enabled ?? true
    const batchPath = config.routing?.batch?.path ?? DEFAULT_BATCH_PATH
    const basePath = config.routing?.basePath

    const syncPushPath = config.routing?.sync?.pushPath ?? DEFAULT_SYNC_PUSH_PATH
    const syncPullPath = config.routing?.sync?.pullPath ?? DEFAULT_SYNC_PULL_PATH
    const syncSubscribePath = config.routing?.sync?.subscribePath ?? DEFAULT_SYNC_SUBSCRIBE_PATH

    const formatTopLevelError = createTopLevelErrorFormatter(config)
    const createRuntime = createRuntimeFactory({ config, requestIdSequencer })
    const services = createServerServices({
        config,
        runtime: { createRuntime, formatTopLevelError },
        routing: { batchPath, restEnabled, traceHeader, requestHeader, syncEnabled }
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
            batchPath,
            restEnabled,
            syncEnabled,
            syncPushPath,
            syncPullPath,
            syncSubscribePath
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
