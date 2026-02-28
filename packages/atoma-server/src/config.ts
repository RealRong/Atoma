import type { AtomaServerLogger } from './logger'
import type { IOrmAdapter, ISyncAdapter } from './adapters/ports'

export type AtomaServerRoute =
    | { kind: 'ops' }
    | { kind: 'sync-rxdb-pull' }
    | { kind: 'sync-rxdb-push' }
    | { kind: 'sync-rxdb-stream' }

export type AtomaServerTraceConfig = {
    createId?: () => string
}

export type AtomaServerPluginRuntime<Ctx> = {
    ctx: Ctx
    traceId?: string
    requestId: string
    logger: AtomaServerLogger
}

export type AtomaOpMiddlewareResult =
    | { ok: true; data: any }
    | { ok: false; error: any }

export type AtomaRouteMiddlewareContext<Ctx> = {
    request: Request
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaErrorMiddlewareContext<Ctx> = AtomaRouteMiddlewareContext<Ctx> & {
    error: unknown
}

export type AtomaOpMiddlewareContext<Ctx> = {
    opId: string
    kind: 'query' | 'write'
    resource?: string
    op: unknown
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaServerMiddleware<Ctx> = {
    onRequest?: (
        ctx: AtomaRouteMiddlewareContext<Ctx>,
        next: () => Promise<void>
    ) => Promise<void>
    onResponse?: (
        ctx: AtomaRouteMiddlewareContext<Ctx>,
        next: () => Promise<Response>
    ) => Promise<Response>
    onError?: (
        ctx: AtomaErrorMiddlewareContext<Ctx>,
        next: () => Promise<void>
    ) => Promise<void>
    onOp?: (
        ctx: AtomaOpMiddlewareContext<Ctx>,
        next: () => Promise<AtomaOpMiddlewareResult>
    ) => Promise<AtomaOpMiddlewareResult>
}

export type AtomaErrorFormatterArgs<Ctx> = {
    ctx?: Ctx
    route?: AtomaServerRoute
    requestId?: string
    traceId?: string
    error: unknown
}

export type AtomaServerConfig<Ctx = unknown> = {
    meta?: {
        name?: string
        env?: 'development' | 'test' | 'production'
    }

    adapter: {
        orm: IOrmAdapter
        sync?: ISyncAdapter
    }

    context?: {
        create?: (args: {
            incoming: any
            route: AtomaServerRoute
            requestId: string
            logger: AtomaServerLogger
        }) => Promise<Ctx> | Ctx
    }

    sync?: {
        enabled?: boolean
        pull?: {
            defaultBatchSize?: number
            maxBatchSize?: number
        }
        push?: {
            maxBatchSize?: number
            idempotencyTtlMs?: number
        }
        stream?: {
            heartbeatMs?: number
            retryMs?: number
            maxHoldMs?: number
        }
    }

    limits?: {
        bodyBytes?: number
        batch?: { maxOps?: number }
        query?: {
            maxQueries?: number
            maxLimit?: number
        }
        write?: {
            maxBatchSize?: number
            maxPayloadBytes?: number
        }
    }

    observability?: {
        logger?: AtomaServerLogger
        trace?: AtomaServerTraceConfig
    }

    errors?: {
        exposeInternalDetails?: boolean
        format?: (args: AtomaErrorFormatterArgs<Ctx>) => { status: number; body: unknown }
    }

    middleware?: AtomaServerMiddleware<Ctx>[]
}
