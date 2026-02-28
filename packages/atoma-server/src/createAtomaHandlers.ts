import type {
    AtomaServerConfig,
    AtomaServerRoute
} from './config'
import type { HandleResult } from './runtime/http'
import { createRuntimeFactory } from './runtime/createRuntime'
import { createTopLevelErrorFormatter } from './runtime/errors'
import { readJsonBodyWithLimit } from './runtime/http'
import { createOpsExecutor } from './ops/opsExecutor'
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return Boolean(value && typeof value === 'object' && typeof (value as any)[Symbol.asyncIterator] === 'function')
}

function serializeErrorForLog(error: unknown) {
    if (error instanceof Error) {
        const anyErr = error as any
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(anyErr?.cause !== undefined ? { cause: anyErr.cause } : {})
        }
    }
    return { value: error }
}

function asyncIterableToReadableStream(body: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
    if (typeof ReadableStream !== 'function') {
        throw new Error('ReadableStream is required to stream subscribe responses')
    }

    const encoder = new TextEncoder()
    const iterator = body[Symbol.asyncIterator]()

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await iterator.next()
            if (done) {
                controller.close()
                return
            }
            if (value === undefined) return
            if (value instanceof Uint8Array) {
                controller.enqueue(value)
                return
            }
            controller.enqueue(encoder.encode(typeof value === 'string' ? value : String(value)))
        },
        async cancel() {
            if (typeof iterator.return === 'function') {
                await iterator.return()
            }
        }
    })
}

function handleResultToResponse(result: HandleResult): Response {
    const headers = new Headers(result.headers ?? {})

    const body = (() => {
        if (result.body === undefined) return null
        if (typeof result.body === 'string') return result.body
        if (isAsyncIterable(result.body)) return asyncIterableToReadableStream(result.body)

        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json; charset=utf-8')
        }
        return JSON.stringify(result.body)
    })()

    return new Response(body, { status: result.status, headers })
}

type PluginRuntime<Ctx> = {
    ctx: Ctx
    traceId?: string
    requestId: string
    logger: any
}

async function invokeOnResponseSafely(args: {
    runtime: any
    route: AtomaServerRoute
    method: string
    pathname: string
    status: number
}) {
    if (!args.runtime.hooks?.onResponse) return

    try {
        await args.runtime.hooks.onResponse({ ...args.runtime.hookArgs, status: args.status })
    } catch (err) {
        args.runtime.logger?.error?.('onResponse hook failed', {
            route: args.route,
            method: args.method,
            pathname: args.pathname,
            status: args.status,
            error: serializeErrorForLog(err)
        })
    }
}

async function invokeOnErrorSafely(args: {
    runtime: any
    route: AtomaServerRoute
    method: string
    pathname: string
    error: unknown
}) {
    if (!args.runtime.hooks?.onError) return

    try {
        await args.runtime.hooks.onError({ ...args.runtime.hookArgs, error: args.error })
    } catch (hookErr) {
        args.runtime.logger?.error?.('onError hook failed', {
            route: args.route,
            method: args.method,
            pathname: args.pathname,
            error: serializeErrorForLog(hookErr),
            sourceError: serializeErrorForLog(args.error)
        })
    }
}

function composeResponsePlugins<Ctx>(
    plugins: Array<(ctx: any, next: () => Promise<Response>) => Promise<Response>>
) {
    if (!plugins.length) {
        return (_ctx: any, next: () => Promise<Response>) => next()
    }

    return (ctx: any, next: () => Promise<Response>) => {
        const execute = (index: number): Promise<Response> => {
            if (index >= plugins.length) return next()
            return plugins[index](ctx, () => execute(index + 1))
        }

        return execute(0)
    }
}

function toIncoming(request: Request) {
    return {
        url: request.url,
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        text: () => request.text(),
        json: () => request.json()
    }
}

export function createAtomaHandlers<Ctx = unknown>(config: AtomaServerConfig<Ctx>) {
    config = normalizeServerConfig(config)

    const syncEnabled = config.sync?.enabled ?? true

    const formatTopLevelError = createTopLevelErrorFormatter(config)
    const createRuntime = createRuntimeFactory({ config })
    const readBodyJson = (incoming: any) => readJsonBodyWithLimit(incoming, config.limits?.bodyBytes)
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

    const runWithRuntime = async (args: {
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
            runtime = await createRuntime({
                incoming: args.request,
                route: args.route,
                initialTraceId: args.initialTraceId,
                initialRequestId: args.initialRequestId
            })
        } catch (err) {
            return handleResultToResponse(formatTopLevelError({
                route: args.route,
                traceId: args.initialTraceId,
                requestId: args.initialRequestId,
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
            if (runtime.hooks?.onRequest) await runtime.hooks.onRequest({ ...runtime.hookArgs, incoming: args.request })

            const response = await args.runResponsePlugins(
                { request: args.request, route: args.route, runtime: pluginRuntime },
                () => args.run(runtime)
            )

            await invokeOnResponseSafely({
                runtime,
                route: args.route,
                method: args.method,
                pathname: args.pathname,
                status: response.status
            })
            return response
        } catch (err: any) {
            runtime.logger?.error?.('request failed', {
                route: args.route,
                method: args.method,
                pathname: args.pathname,
                error: serializeErrorForLog(err)
            })
            await invokeOnErrorSafely({
                runtime,
                route: args.route,
                method: args.method,
                pathname: args.pathname,
                error: err
            })

            const formatted = formatTopLevelError({
                route: args.route,
                ctx: runtime.ctx,
                requestId: runtime.requestId,
                traceId: runtime.traceId,
                error: err
            })
            const response = handleResultToResponse(formatted)
            await invokeOnResponseSafely({
                runtime,
                route: args.route,
                method: args.method,
                pathname: args.pathname,
                status: response.status
            })
            return response
        }
    }

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

function resolveQueryValue(urlObj: URL, key: string): string | undefined {
    const value = urlObj.searchParams.get(key)
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized ? normalized : undefined
}
