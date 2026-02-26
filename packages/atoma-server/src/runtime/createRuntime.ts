import { createId } from 'atoma-shared'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import { createNoopLogger } from '../logger'

function createDefaultRequestId() {
    return createId({ kind: 'request' })
}

function createTraceRequestId(traceId: string) {
    return `r_${traceId}_1`
}

function resolveNonEmpty(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized ? normalized : undefined
}

export function createRuntimeFactory<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
}) {
    const { config } = args

    const loggerBase = config.observability?.logger ?? createNoopLogger()
    const createTraceId = config.observability?.trace?.createId
    const hooks = config.observability?.hooks

    return async function createRuntime(runtimeArgs: {
        incoming: any
        route: AtomaServerRoute
        initialTraceId?: string
        initialRequestId?: string
    }) {
        const traceId = resolveNonEmpty(runtimeArgs.initialTraceId)
            ?? (typeof createTraceId === 'function' ? resolveNonEmpty(createTraceId()) : undefined)

        const requestId = (() => {
            const initialRequestId = resolveNonEmpty(runtimeArgs.initialRequestId)
            if (initialRequestId) return initialRequestId
            if (traceId) return createTraceRequestId(traceId)
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

        return { traceId, requestId, logger, ctx, hookArgs, hooks }
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
    hooks?: any
}
