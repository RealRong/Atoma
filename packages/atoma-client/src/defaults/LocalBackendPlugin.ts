import type { ClientPlugin } from 'atoma-types/client/plugins'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { OperationClient } from 'atoma-types/client/ops'
import type { Entity, Query } from 'atoma-types/core'
import type { QueryResultData, RemoteOpResult, WriteResultData } from 'atoma-types/protocol'

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

export function localBackendPlugin(): ClientPlugin {
    return {
        id: 'defaults:local-backend',
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
            const operationClient: OperationClient = {
                executeOperations: async (input) => {
                    if (!input.ops.length) return { results: [] }

                    const results: RemoteOpResult[] = []
                    for (const op of input.ops) {
                        if (op.kind === 'query') {
                            const storeName = String(op.query.resource)
                            const handle = ctx.runtime.stores.resolveHandle<Entity>({
                                storeName,
                                reason: 'defaults.local.operation.query'
                            })
                            const local = ctx.runtime.engine.query.evaluate({
                                state: handle.state,
                                query: op.query.query as Query<Entity>
                            })
                            results.push({
                                opId: op.opId,
                                ok: true,
                                data: toQueryResultData(local.data as unknown[], local.pageInfo)
                            })
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
            }

            const unregister = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            return {
                dispose: () => {
                    try {
                        unregister?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
