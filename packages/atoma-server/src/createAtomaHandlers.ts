import type { AtomaServerConfig } from './config'
import { composeResponsePlugins } from './entry/pluginChain'
import { handleResultToResponse, toIncoming } from './entry/response'
import { createRuntimeRunner } from './entry/runWithRuntime'
import { createOpsExecutor } from './ops/opsExecutor'
import { createRuntimeFactory } from './runtime/createRuntime'
import { createTopLevelErrorFormatter } from './runtime/errors'
import { readJsonBodyWithLimit } from './runtime/http'
import {
    createSyncRxdbPullExecutor,
    createSyncRxdbPushExecutor,
    createSyncRxdbStreamExecutor
} from './sync-rxdb'

function isObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertFunction(value: unknown, message: string): void {
    if (value !== undefined && typeof value !== 'function') {
        throw new Error(message)
    }
}

function normalizeServerConfig<Ctx>(config: AtomaServerConfig<Ctx>): AtomaServerConfig<Ctx> {
    if (!isObject(config.adapter) || !config.adapter.orm) {
        throw new Error('AtomaServerConfig.adapter.orm is required')
    }

    const syncEnabled = config.sync?.enabled ?? true
    if (syncEnabled) {
        if (!config.adapter.sync) {
            throw new Error('AtomaServerConfig.adapter.sync is required when sync is enabled')
        }
        if (typeof (config.adapter.orm as any)?.transaction !== 'function') {
            throw new Error('AtomaServerConfig.adapter.orm.transaction is required when sync is enabled')
        }
    }

    assertFunction(config.context?.create, 'AtomaServerConfig.context.create must be a function')
    assertFunction(config.errors?.format, 'AtomaServerConfig.errors.format must be a function')

    const hooks = config.observability?.hooks
    assertFunction(hooks?.onRequest, 'AtomaServerConfig.observability.hooks.onRequest must be a function')
    assertFunction(hooks?.onResponse, 'AtomaServerConfig.observability.hooks.onResponse must be a function')
    assertFunction(hooks?.onError, 'AtomaServerConfig.observability.hooks.onError must be a function')

    return (config.sync?.enabled === undefined)
        ? {
            ...config,
            sync: {
                ...(config.sync ?? {}),
                enabled: syncEnabled
            }
        }
        : config
}

function resolveQueryValue(urlObj: URL, key: string): string | undefined {
    const value = urlObj.searchParams.get(key)
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized ? normalized : undefined
}

export function createAtomaHandlers<Ctx = unknown>(config: AtomaServerConfig<Ctx>) {
    config = normalizeServerConfig(config)

    const syncEnabled = config.sync?.enabled ?? true
    const formatTopLevelError = createTopLevelErrorFormatter(config)
    const createRuntime = createRuntimeFactory({ config })
    const readBodyJson = (incoming: any) => readJsonBodyWithLimit(incoming, config.limits?.bodyBytes)
    const runWithRuntime = createRuntimeRunner<Ctx>({
        createRuntime,
        formatTopLevelError
    })

    const opsExecutor = createOpsExecutor({
        config,
        readBodyJson,
        syncEnabled,
        opPlugins: config.plugins?.op
    })
    const syncPullExecutor = createSyncRxdbPullExecutor({
        config,
        readBodyJson
    })
    const syncPushExecutor = createSyncRxdbPushExecutor({
        config,
        readBodyJson
    })
    const syncStreamExecutor = createSyncRxdbStreamExecutor({
        config
    })

    const runOpsResponsePlugins = composeResponsePlugins<Ctx>(config.plugins?.ops ?? [])
    const runPullResponsePlugins = composeResponsePlugins<Ctx>(config.plugins?.syncRxdbPull ?? [])
    const runPushResponsePlugins = composeResponsePlugins<Ctx>(config.plugins?.syncRxdbPush ?? [])
    const runStreamResponsePlugins = composeResponsePlugins<Ctx>(config.plugins?.syncRxdbStream ?? [])

    return {
        ops: async (request: Request): Promise<Response> => {
            const urlObj = new URL(request.url)
            const pathname = urlObj.pathname
            const method = request.method.toUpperCase()

            return runWithRuntime({
                request,
                route: { kind: 'ops' },
                method,
                pathname,
                runResponsePlugins: runOpsResponsePlugins,
                run: async (runtime) => {
                    const incoming = toIncoming(request)
                    const result = await opsExecutor.handle({
                        incoming,
                        method,
                        pathname,
                        runtime
                    })
                    return handleResultToResponse(result)
                }
            })
        },
        syncRxdbPull: async (request: Request): Promise<Response> => {
            const urlObj = new URL(request.url)
            const pathname = urlObj.pathname
            const method = request.method.toUpperCase()
            const initialTraceId = resolveQueryValue(urlObj, 'traceId')
            const initialRequestId = resolveQueryValue(urlObj, 'requestId')

            return runWithRuntime({
                request,
                route: { kind: 'sync-rxdb-pull' },
                method,
                pathname,
                initialTraceId,
                initialRequestId,
                runResponsePlugins: runPullResponsePlugins,
                run: async (runtime) => {
                    const incoming = toIncoming(request)
                    const result = await syncPullExecutor.handle({
                        incoming,
                        method,
                        runtime
                    })
                    return handleResultToResponse(result)
                }
            })
        },
        syncRxdbPush: async (request: Request): Promise<Response> => {
            const urlObj = new URL(request.url)
            const pathname = urlObj.pathname
            const method = request.method.toUpperCase()
            const initialTraceId = resolveQueryValue(urlObj, 'traceId')
            const initialRequestId = resolveQueryValue(urlObj, 'requestId')

            return runWithRuntime({
                request,
                route: { kind: 'sync-rxdb-push' },
                method,
                pathname,
                initialTraceId,
                initialRequestId,
                runResponsePlugins: runPushResponsePlugins,
                run: async (runtime) => {
                    const incoming = toIncoming(request)
                    const result = await syncPushExecutor.handle({
                        incoming,
                        method,
                        runtime
                    })
                    return handleResultToResponse(result)
                }
            })
        },
        syncRxdbStream: async (request: Request): Promise<Response> => {
            const urlObj = new URL(request.url)
            const pathname = urlObj.pathname
            const method = request.method.toUpperCase()
            const initialTraceId = resolveQueryValue(urlObj, 'traceId')
            const initialRequestId = resolveQueryValue(urlObj, 'requestId')

            return runWithRuntime({
                request,
                route: { kind: 'sync-rxdb-stream' },
                method,
                pathname,
                initialTraceId,
                initialRequestId,
                runResponsePlugins: runStreamResponsePlugins,
                run: async (runtime) => {
                    const incoming = toIncoming(request)
                    const result = await syncStreamExecutor.handle({
                        incoming,
                        urlObj,
                        method,
                        route: { kind: 'sync-rxdb-stream' },
                        runtime
                    })
                    return handleResultToResponse(result)
                }
            })
        }
    }
}
