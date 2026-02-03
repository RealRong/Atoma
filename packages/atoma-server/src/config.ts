import type { DebugConfig, DebugEvent } from 'atoma-types/observability'
import type { AtomaServerLogger } from './logger'
import type { IOrmAdapter, ISyncAdapter } from './adapters/ports'

export type AtomaServerRoute =
    | { kind: 'ops' }
    | { kind: 'subscribe' }

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

export type AtomaServerDebugConfig = {
    scope?: string
    debug?: DebugConfig
    onEvent?: (e: DebugEvent) => void
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

export type AtomaSubscribePluginContext<Ctx> = {
    request: Request
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaOpPluginContext<Ctx> = {
    opId: string
    kind: 'query' | 'write' | 'changes.pull'
    resource?: string
    op: unknown
    route: AtomaServerRoute
    runtime: AtomaServerPluginRuntime<Ctx>
}

export type AtomaOpsPlugin<Ctx> = (ctx: AtomaOpsPluginContext<Ctx>, next: () => Promise<Response>) => Promise<Response>
export type AtomaSubscribePlugin<Ctx> = (ctx: AtomaSubscribePluginContext<Ctx>, next: () => Promise<Response>) => Promise<Response>
export type AtomaOpPlugin<Ctx> = (ctx: AtomaOpPluginContext<Ctx>, next: () => Promise<AtomaOpPluginResult>) => Promise<AtomaOpPluginResult>

export type AtomaServerPlugins<Ctx> = {
    ops?: AtomaOpsPlugin<Ctx>[]
    subscribe?: AtomaSubscribePlugin<Ctx>[]
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
        tables?: {
            changes?: string
            idempotency?: string
        }
        push?: {
            maxOps?: number
            idempotencyTtlMs?: number
        }
        pull?: {
            defaultLimit?: number
            maxLimit?: number
        }
        subscribe?: {
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
        syncPush?: { maxOps?: number }
        syncPull?: { maxLimit?: number }
    }

    observability?: {
        logger?: AtomaServerLogger
        trace?: AtomaServerTraceConfig
        debug?: AtomaServerDebugConfig
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
