import type { ClientPlugin, IoHandler, PersistHandler, PluginContext, ReadHandler, Register } from 'atoma-types/client'
import type { Query } from 'atoma-types/core'
import type { Operation, OperationResult, QueryResultData } from 'atoma-types/protocol'
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

function queryLocal(ctx: PluginContext, storeName: string, query: Query): QueryResultData {
    const handle = ctx.runtime.stores.resolveHandle(storeName, 'LocalBackendPlugin.query')
    const local = ctx.runtime.engine.query.evaluate({
        state: handle.state,
        query: query as Query<any>
    })
    return toQueryResultData(local.data as unknown[], local.pageInfo)
}

function toUnsupportedOpsResults(ops: Operation[]): OperationResult[] {
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
            const ioHandler: IoHandler = async (req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream

                if (!req.ops.length) return { results: [] }
                const results: OperationResult[] = []
                for (const op of req.ops) {
                    if (op.kind === 'query') {
                        const data = queryLocal(ctx, op.query.resource, op.query.query)
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
                return queryLocal(ctx, String(req.storeName), req.query)
            }

            const persistHandler: PersistHandler = async (_req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream
                return { status: 'confirmed' }
            }

            register('io', ioHandler, { priority: -1000 })
            register('read', readHandler, { priority: -1000 })
            register('persist', persistHandler, { priority: -1000 })
        }
    }
}
