import type { DebugConfig, DebugEvent } from '#observability'
import type { AtomaServerLogger } from './logger'
import type { IOrmAdapter } from './types'
import type { ISyncAdapter } from './sync/types'
import type { FieldPolicyInput } from './guard/fieldPolicy'
import type { ServerPlugin } from './engine/plugins'

export type AtomaServerRoute =
    | { kind: 'ops' }
    | { kind: 'sync'; name: 'pull' | 'subscribe' }

export type AtomaServerHookArgs<Ctx> = {
    route: AtomaServerRoute
    ctx: Ctx
    traceId?: string
    requestId?: string
}

export type AtomaServerHook<TArgs> = (args: TArgs) => void | Promise<void>

export type AtomaAuthorizeHookArgs<Ctx> = AtomaServerHookArgs<Ctx> & {
    action: 'query' | 'write' | 'sync'
    resource: string
    op: unknown
}

export type AtomaFilterQueryHookArgs<Ctx> = AtomaServerHookArgs<Ctx> & {
    resource: string
    params: unknown
    op: unknown
}

export type AtomaValidateWriteHookArgs<Ctx> = AtomaServerHookArgs<Ctx> & {
    resource: string
    op: unknown
    item: unknown
    changedFields: string[]
    changedPaths?: Array<Array<string | number>>
    getCurrent: (fields: string[]) => Promise<unknown | undefined>
}

export type AtomaAuthzHooks<Ctx> = {
    authorize?: Array<(args: AtomaAuthorizeHookArgs<Ctx>) => void | Promise<void>>
    filterQuery?: Array<(args: AtomaFilterQueryHookArgs<Ctx>) => Record<string, any> | void | Promise<Record<string, any> | void>>
    validateWrite?: Array<(args: AtomaValidateWriteHookArgs<Ctx>) => void | Promise<void>>
}

export type AtomaServerTraceConfig = {
    traceIdHeader?: string
    requestIdHeader?: string
    createId?: () => string
}

export type AtomaServerDebugConfig = {
    scope?: string
    debug?: DebugConfig
    onEvent?: (e: DebugEvent) => void
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
        sync: ISyncAdapter
    }

    context?: {
        create?: (args: {
            incoming: any
            route: AtomaServerRoute
            requestId: string
            logger: AtomaServerLogger
        }) => Promise<Ctx> | Ctx
    }

    routing?: {
        basePath?: string
        ops?: { path?: string }
        sync?: {
            enabled?: boolean
            subscribeVNextPath?: string
        }
    }

    /**
     * 插件系统：用可组合模块替代“before/after 路由注入”。
     * - 插件按顺序 setup，收集 routes 与 middleware
     * - 内置路由由 DefaultRoutesPlugin 提供（createAtomaServer 会自动追加到最后）
     * - 想完全替换内置行为：提供一个 match-all 的 routes 插件放在前面即可
     */
    plugins?: Array<ServerPlugin<Ctx>>

    authz?: {
        resources?: {
            allow?: string[]
            deny?: string[]
        }
        hooks?: AtomaAuthzHooks<Ctx>
        perResource?: Record<string, {
            hooks?: AtomaAuthzHooks<Ctx>
            fieldPolicy?: FieldPolicyInput
        }>
        fieldPolicy?: FieldPolicyInput
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
            onValidated?: AtomaServerHook<AtomaServerHookArgs<Ctx> & { request: unknown }>
            onAuthorized?: AtomaServerHook<AtomaServerHookArgs<Ctx>>
            onResponse?: AtomaServerHook<AtomaServerHookArgs<Ctx> & { status: number }>
            onError?: AtomaServerHook<AtomaServerHookArgs<Ctx> & { error: unknown }>
        }
    }

    errors?: {
        exposeInternalDetails?: boolean
        format?: (args: AtomaErrorFormatterArgs<Ctx>) => { status: number; body: unknown }
    }
}
