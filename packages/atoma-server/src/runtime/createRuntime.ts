import { Observability } from 'atoma-observability'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import { createNoopLogger } from '../logger'
import type { ObservabilityContext } from 'atoma-types/observability'

function createDefaultRequestId() {
    const cryptoAny = globalThis.crypto as any
    const uuid = cryptoAny?.randomUUID?.()
    if (typeof uuid === 'string' && uuid) return `r_${uuid}`
    return `r_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function createRuntimeFactory<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
}) {
    const { config } = args

    const loggerBase = config.observability?.logger ?? createNoopLogger()
    const debugScope = config.observability?.debug?.scope ?? 'atoma-server'
    const debugConfig = config.observability?.debug?.debug
    const debugOnEvent = config.observability?.debug?.onEvent
    const createIdFn = config.observability?.trace?.createId
    const hooks = config.observability?.hooks
    const observability = Observability.runtime.create({ scope: debugScope, debug: debugConfig, onEvent: debugOnEvent })

    return async function createRuntime(runtimeArgs: {
        incoming: any
        route: AtomaServerRoute
        initialTraceId?: string
        initialRequestId?: string
    }) {
        const createObservabilityContext = (ctxArgs?: { traceId?: string; requestId?: string; opId?: string }): ObservabilityContext => {
            const traceId = (typeof ctxArgs?.traceId === 'string' && ctxArgs.traceId) ? ctxArgs.traceId : undefined
            const base = observability.createContext({ traceId })
            const requestId = (typeof ctxArgs?.requestId === 'string' && ctxArgs.requestId) ? ctxArgs.requestId : undefined
            const withRequest = requestId ? base.with({ requestId }) : base
            const opId = (typeof ctxArgs?.opId === 'string' && ctxArgs.opId) ? ctxArgs.opId : undefined
            return opId ? withRequest.with({ opId }) : withRequest
        }

        const initialTraceId = (() => {
            if (typeof runtimeArgs.initialTraceId === 'string' && runtimeArgs.initialTraceId) return runtimeArgs.initialTraceId
            if (typeof createIdFn === 'function') return createIdFn()
            return undefined
        })()

        const baseCtx = observability.createContext({ traceId: initialTraceId })
        const traceId = baseCtx.traceId

        const requestId = (() => {
            if (typeof runtimeArgs.initialRequestId === 'string' && runtimeArgs.initialRequestId) return runtimeArgs.initialRequestId
            if (traceId) return baseCtx.requestId() ?? createDefaultRequestId()
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
        const observabilityContext = baseCtx.with({ requestId })

        return { traceId, requestId, logger, ctx, hookArgs, observabilityContext, createObservabilityContext, hooks }
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
    observabilityContext: ObservabilityContext
    createObservabilityContext: (args?: { traceId?: string; requestId?: string; opId?: string }) => ObservabilityContext
    hooks?: any
}
