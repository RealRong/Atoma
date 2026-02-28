import type { AtomaServerLogger } from './logger'
import type { IOrmAdapter, ISyncAdapter } from './adapters/ports'

export type AtomaServerRoute =
    | { kind: 'ops' }
    | { kind: 'sync-rxdb-pull' }
    | { kind: 'sync-rxdb-push' }
    | { kind: 'sync-rxdb-stream' }

export type AtomaServerHookArgs<Ctx> = {
    route: AtomaServerRoute
    ctx: Ctx
    traceId?: string
    requestId?: string
}

export type AtomaServerHook<TArgs> = (args: TArgs) => void | Promise<void>

export type AtomaServerTraceConfig = {
    createId?: () => string
}

export type AtomaServerPluginRuntime<Ctx> = {
    ctx: Ctx
    traceId?: string
    requestId: string
    logger: AtomaServerLogger
}

export type AtomaOpPluginResult =
    | { ok: true; data: any }
    | { ok: false; error: any }

export type AtomaOpsPluginContext<Ctx> = {
    request: Request
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaRoutePluginContext<Ctx> = {
    request: Request
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaOpPluginContext<Ctx> = {
    opId: string
    kind: 'query' | 'write'
    resource?: string
    op: unknown
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaOpsPlugin<Ctx> = (ctx: AtomaOpsPluginContext<Ctx>, next: () => Promise<Response>) => Promise<Response>
export type AtomaRoutePlugin<Ctx> = (ctx: AtomaRoutePluginContext<Ctx>, next: () => Promise<Response>) => Promise<Response>
export type AtomaOpPlugin<Ctx> = (ctx: AtomaOpPluginContext<Ctx>, next: () => Promise<AtomaOpPluginResult>) => Promise<AtomaOpPluginResult>

export type AtomaServerPlugins<Ctx> = {
    ops?: AtomaOpsPlugin<Ctx>[]
    syncRxdbPull?: AtomaRoutePlugin<Ctx>[]
    syncRxdbPush?: AtomaRoutePlugin<Ctx>[]
    syncRxdbStream?: AtomaRoutePlugin<Ctx>[]
    op?: AtomaOpPlugin<Ctx>[]
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
        hooks?: {
            onRequest?: AtomaServerHook<AtomaServerHookArgs<Ctx> & { incoming: any }>
            onResponse?: AtomaServerHook<AtomaServerHookArgs<Ctx> & { status: number }>
            onError?: AtomaServerHook<AtomaServerHookArgs<Ctx> & { error: unknown }>
        }
    }

    errors?: {
        exposeInternalDetails?: boolean
        format?: (args: AtomaErrorFormatterArgs<Ctx>) => { status: number; body: unknown }
    }

    plugins?: AtomaServerPlugins<Ctx>
}
