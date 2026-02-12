import type { ClientPlugin, OpsHandler, PluginContext, OpsRegister } from 'atoma-types/client/plugins'
import type { Entity, Query } from 'atoma-types/core'
import type { QueryResultData, RemoteOpResult, WriteResultData } from 'atoma-types/protocol'
import { isTerminalResult } from '../plugins/OpsChain'

function toQueryResultData(data: unknown[], pageInfo?: unknown): QueryResultData {
    if (pageInfo === undefined) {
        return { data }
    }
    return {
        data,
        pageInfo: pageInfo as QueryResultData['pageInfo']
    }
}

function toWriteResultData(entries: Array<{ entryId: string; item: { entityId?: string } }>): WriteResultData {
    return {
        results: entries.map(entry => ({
            entryId: entry.entryId,
            ok: true,
            entityId: String(entry.item.entityId ?? ''),
            version: 1
        }))
    }
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
        register: (ctx: PluginContext, register: OpsRegister) => {
            const opsHandler: OpsHandler = async (req, _ctx, next) => {
                const upstream = await next()
                if (!isTerminalResult(upstream)) return upstream

                if (!req.ops.length) return { results: [] }

                const results: RemoteOpResult[] = []
                for (const op of req.ops) {
                    if (op.kind === 'query') {
                        const data = runLocalQuery(ctx, String(op.query.resource), op.query.query as Query<Entity>)
                        results.push({ opId: op.opId, ok: true, data })
                        continue
                    }

                    if (op.kind === 'write') {
                        results.push({
                            opId: op.opId,
                            ok: true,
                            data: toWriteResultData(op.write.entries as Array<{ entryId: string; item: { entityId?: string } }>),
                        })
                        continue
                    }

                    results.push({
                        opId: op.opId,
                        ok: false,
                        error: {
                            code: 'LOCAL_ONLY',
                            message: `[Atoma] LocalBackendPlugin: unsupported op kind ${String(op.kind)}`,
                            kind: 'internal'
                        }
                    })
                }

                return { results }
            }

            register(opsHandler, { priority: -1000 })
        }
    }
}
