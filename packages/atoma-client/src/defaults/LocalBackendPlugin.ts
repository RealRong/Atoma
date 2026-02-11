import type { ClientPlugin, OpsHandler, PersistHandler, PluginContext, ReadHandler, Register } from 'atoma-types/client/plugins'
import type { Entity, Query } from 'atoma-types/core'
import type { RemoteOp, RemoteOpResult, QueryResultData } from 'atoma-types/protocol'
import { isTerminalResult } from '../plugins/HandlerChain'

function toQueryResultData(data: unknown[], pageInfo?: unknown): QueryResultData {
    if (pageInfo === undefined) {
        return { data }
    }
    return {
        data,
        pageInfo: pageInfo as QueryResultData['pageInfo']
    }
}

function toUnsupportedOpsResults(ops: RemoteOp[]): RemoteOpResult[] {
    return ops.map(op => ({
        opId: op.opId,
        ok: false,
        error: {
            code: 'LOCAL_ONLY',
            message: '[Atoma] LocalBackendPlugin: ops not supported',
            kind: 'internal'
        }
    }))
}

function runLocalQuery(ctx: PluginContext, storeName: string, query: Query<Entity>): QueryResultData {
    const handle = ctx.runtime.stores.resolveHandle(storeName, 'LocalBackendPlugin.query')
    const local = ctx.runtime.engine.query.evaluate({
        state: handle.state,
        query
    })
    return toQueryResultData(local.data as unknown[], local.pageInfo)
}

export function localBackendPlugin(): ClientPlugin {
    return {
        id: 'defaults:local-backend',
        register: (ctx: PluginContext, register: Register) => {
            const opsHandler: OpsHandler = async (req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream

                if (!req.ops.length) return { results: [] }

                const results: RemoteOpResult[] = []
                for (const op of req.ops) {
                    if (op.kind !== 'query') {
                        results.push(...toUnsupportedOpsResults([op]))
                        continue
                    }

                    const data = runLocalQuery(ctx, String(op.query.resource), op.query.query as Query<Entity>)
                    results.push({ opId: op.opId, ok: true, data })
                }

                return { results }
            }

            const readHandler: ReadHandler = async (req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream

                return runLocalQuery(ctx, String(req.storeName), req.query as Query<Entity>)
            }

            const persistHandler: PersistHandler = async (_req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream
                return { status: 'confirmed' }
            }

            register('ops', opsHandler, { priority: -1000 })
            register('read', readHandler, { priority: -1000 })
            register('persist', persistHandler, { priority: -1000 })
        }
    }
}
