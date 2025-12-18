import { createDebugEmitter } from '../../observability/debug'
import type { RequestIdSequencer } from '../../observability/trace'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import { createNoopLogger } from '../logger'

function createDefaultRequestId() {
    const cryptoAny = globalThis.crypto as any
    const uuid = cryptoAny?.randomUUID?.()
    if (typeof uuid === 'string' && uuid) return `r_${uuid}`
    return `r_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function createRuntimeFactory<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    requestIdSequencer: RequestIdSequencer
}) {
    const { config, requestIdSequencer } = args

    const loggerBase = config.observability?.logger ?? createNoopLogger()
    const debugStore = config.observability?.debug?.store ?? 'atoma/server'
    const debugOptions = config.observability?.debug?.options
    const debugSink = config.observability?.debug?.sink
    const createTraceIdFn = config.observability?.trace?.createTraceId
    const hooks = config.observability?.hooks

    return async function createRuntime(runtimeArgs: {
        incoming: any
        route: AtomaServerRoute
        initialTraceId?: string
        initialRequestId?: string
    }) {
        const traceId = (() => {
            if (typeof runtimeArgs.initialTraceId === 'string' && runtimeArgs.initialTraceId) return runtimeArgs.initialTraceId
            if (typeof createTraceIdFn === 'function') return createTraceIdFn()
            return undefined
        })()

        const requestId = (() => {
            if (typeof runtimeArgs.initialRequestId === 'string' && runtimeArgs.initialRequestId) return runtimeArgs.initialRequestId
            if (traceId) return requestIdSequencer.next(traceId)
            return createDefaultRequestId()
        })()

        const logger = loggerBase.child
            ? loggerBase.child({
                ...(config.meta?.name ? { server: config.meta.name } : {}),
                ...(traceId ? { traceId } : {}),
                ...(requestId ? { requestId } : {})
            })
            : loggerBase

        const ctx = config.context?.create
            ? await config.context.create({ incoming: runtimeArgs.incoming, route: runtimeArgs.route, requestId, logger })
            : (undefined as any as Ctx)

        const hookArgs = { route: runtimeArgs.route, ctx, traceId, requestId }
        const emitter = createDebugEmitter({
            debug: debugOptions,
            traceId,
            store: debugStore,
            sink: debugSink
        })

        return { traceId, requestId, logger, ctx, hookArgs, emitter, hooks }
    }
}

export type ServerRuntime<Ctx> = {
    traceId?: string
    requestId: string
    logger: any
    ctx: Ctx
    hookArgs: {
        route: AtomaServerRoute
        ctx: Ctx
        traceId?: string
        requestId: string
    }
    emitter?: { emit: (...args: any[]) => any }
    hooks?: any
}
