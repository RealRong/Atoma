import type { Entity } from 'atoma-types/core'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { QueryOutput, QueryRequest, RuntimeWriteEntry, RuntimeWriteItemResult, WriteOutput, WriteRequest } from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'
import { createOperationExecutionSpec } from './adapters/operationExecutionAdapter'
import type { ServiceRegistry } from '../plugins/ServiceRegistry'

function toLocalWriteResults(entries: ReadonlyArray<RuntimeWriteEntry>): RuntimeWriteItemResult[] {
    const results: RuntimeWriteItemResult[] = []

    for (const entry of entries) {
        const rawEntityId = (entry.item as { entityId?: unknown })?.entityId
        const rawBaseVersion = (entry.item as { baseVersion?: unknown })?.baseVersion
        const entityId = (
            typeof rawEntityId === 'string' && rawEntityId.length
                ? rawEntityId
                : entry.entryId
        )
        const version = (
            typeof rawBaseVersion === 'number' && Number.isFinite(rawBaseVersion) && rawBaseVersion > 0
                ? rawBaseVersion + 1
                : 1
        )
        results.push({
            entryId: entry.entryId,
            ok: true,
            entityId,
            version
        })
    }

    return results
}

export function installDirectStrategy({
    runtime,
    services
}: {
    runtime: Runtime
    services: ServiceRegistry
}): () => void {
    return runtime.execution.apply({
        id: 'builtin.direct',
        executors: {
            local: {
                query: async <T extends Entity>(request: QueryRequest<T>): Promise<QueryOutput> => {
                    const local = runtime.engine.query.evaluate({
                        state: request.handle.state,
                        query: request.query
                    })

                    return {
                        data: local.data,
                        source: 'local',
                        ...(local.pageInfo !== undefined ? { pageInfo: local.pageInfo } : {})
                    }
                },
                write: async <T extends Entity>(request: WriteRequest<T>): Promise<WriteOutput<T>> => {
                    const results = toLocalWriteResults(request.entries)
                    return {
                        status: 'confirmed',
                        ...(results.length ? { results } : {})
                    }
                }
            },
            operation: createOperationExecutionSpec({
                runtime,
                resolveOperation: () => services.resolve(OPERATION_CLIENT_TOKEN)
            })
        },
        routes: {
            'direct-local': {
                query: 'local',
                write: 'local'
            },
            'direct-operation': {
                query: 'operation',
                write: 'operation'
            }
        }
    })
}
