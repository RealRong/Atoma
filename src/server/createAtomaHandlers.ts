import type { AtomaServerConfig, AtomaServerRoute, AtomaOpsPlugin, AtomaSubscribePlugin } from './config'
import type { HandleResult } from './runtime/http'
import { createRuntimeFactory } from './runtime/createRuntime'
import { createTopLevelErrorFormatter } from './runtime/errors'
import { readJsonBodyWithLimit } from './runtime/http'
import { createOpsExecutor } from './core/opsExecutor'
import { createSubscribeExecutor } from './core/subscribeExecutor'

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return Boolean(value && typeof value === 'object' && typeof (value as any)[Symbol.asyncIterator] === 'function')
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

function composeResponsePlugins<Ctx>(
    plugins: Array<(ctx: any, next: () => Promise<Response>) => Promise<Response>>
) {
    return (ctx: any, next: () => Promise<Response>) => {
        const dispatch = plugins.reduceRight<() => Promise<Response>>(
            (nextFn, plugin) => () => plugin(ctx, nextFn),
            next
        )
        return dispatch()
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
    if (!config?.adapter?.orm) {
        throw new Error('AtomaServerConfig.adapter.orm is required')
    }

    const syncEnabled = config.sync?.enabled ?? true
    if (syncEnabled && !config.adapter.sync) {
        throw new Error('AtomaServerConfig.adapter.sync is required when sync is enabled')
    }
    if (syncEnabled && typeof (config.adapter.orm as any)?.transaction !== 'function') {
        throw new Error('AtomaServerConfig.adapter.orm.transaction is required when sync is enabled')
    }

    const formatTopLevelError = createTopLevelErrorFormatter(config)
    const createRuntime = createRuntimeFactory({ config })
    const readBodyJson = (incoming: any) => readJsonBodyWithLimit(incoming, config.limits?.bodyBytes)
    const opsExecutor = createOpsExecutor({
        config,
        readBodyJson,
        syncEnabled,
        opPlugins: config.plugins?.op
    })
    const subscribeExecutor = createSubscribeExecutor({
        config
    })

    const runWithRuntime = async (args: {
        request: Request
        route: AtomaServerRoute
        method: string
        pathname: string
        initialTraceId?: string
        initialRequestId?: string
        plugins?: Array<AtomaOpsPlugin<Ctx> | AtomaSubscribePlugin<Ctx>>
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
            runtime.observabilityContext.emit('server:request', { method: args.method, pathname: args.pathname })

            const response = await composeResponsePlugins<Ctx>(args.plugins ?? [])(
                { request: args.request, route: args.route, runtime: pluginRuntime },
                () => args.run(runtime)
            )

            if (runtime.hooks?.onResponse) await runtime.hooks.onResponse({ ...runtime.hookArgs, status: response.status })
            return response
        } catch (err: any) {
            runtime.observabilityContext.emit('server:error', { message: err?.message })
            if (runtime.hooks?.onError) await runtime.hooks.onError({ ...runtime.hookArgs, error: err })

            const formatted = formatTopLevelError({
                route: args.route,
                ctx: runtime.ctx,
                requestId: runtime.requestId,
                traceId: runtime.traceId,
                error: err
            })
            const response = handleResultToResponse(formatted)
            if (runtime.hooks?.onResponse) await runtime.hooks.onResponse({ ...runtime.hookArgs, status: response.status })
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
                plugins: config.plugins?.ops,
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
        subscribe: async (request: Request): Promise<Response> => {
            const urlObj = new URL(request.url)
            const pathname = urlObj.pathname
            const method = request.method.toUpperCase()

            const initialTraceId = (() => {
                const q = urlObj.searchParams.get('traceId')
                if (typeof q === 'string' && q) return q
                return undefined
            })()
            const initialRequestId = (() => {
                const q = urlObj.searchParams.get('requestId')
                if (typeof q === 'string' && q) return q
                return undefined
            })()

            return runWithRuntime({
                request,
                route: { kind: 'subscribe' },
                method,
                pathname,
                initialTraceId,
                initialRequestId,
                plugins: config.plugins?.subscribe,
                run: async (runtime) => {
                    const incoming = toIncoming(request)
                    const result = await subscribeExecutor.subscribe({
                        incoming,
                        urlObj,
                        method,
                        pathname,
                        route: { kind: 'subscribe' },
                        runtime
                    })
                    return handleResultToResponse(result)
                }
            })
        }
    }
}
