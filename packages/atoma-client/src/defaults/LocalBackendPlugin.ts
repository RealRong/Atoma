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
                    if (op.kind === 'query') {
                        const handle = ctx.runtime.stores.resolveHandle(op.query.resource, 'LocalBackendPlugin.ops.query')
                        const local = ctx.runtime.engine.query.evaluate({
                            state: handle.state,
                            query: op.query.query as Query<Entity>
                        })
                        const data = toQueryResultData(local.data as unknown[], local.pageInfo)
                        results.push({ opId: op.opId, ok: true, data })
                        continue
                    }
                    results.push(...toUnsupportedOpsResults([op]))
                }
                return { results }
            }

            const readHandler: ReadHandler = async (req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream

                const handle = ctx.runtime.stores.resolveHandle(String(req.storeName), 'LocalBackendPlugin.read.query')
                const local = ctx.runtime.engine.query.evaluate({
                    state: handle.state,
                    query: req.query as Query<Entity>
                })
                return toQueryResultData(local.data as unknown[], local.pageInfo)
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
