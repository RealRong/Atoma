import type { Entity, ExecutionRoute } from 'atoma-types/core'
import type {
    QueryOutput,
    QueryRequest,
    WriteItemResult,
    WriteOutput,
    WriteRequest
} from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'

const EXECUTOR_ID = 'local'
export const LOCAL_ROUTE: ExecutionRoute = 'direct-local'

export function registerLocalRoute(runtime: Runtime): () => void {
    return runtime.execution.apply({
        id: 'builtin.direct',
        executors: {
            [EXECUTOR_ID]: {
                query: async <T extends Entity>({ handle, query }: QueryRequest<T>): Promise<QueryOutput> => {
                    const { data, pageInfo } = runtime.engine.query.evaluate({
                        state: handle.state,
                        query
                    })
                    return {
                        data,
                        source: 'local',
                        ...(pageInfo !== undefined ? { pageInfo } : {})
                    }
                },
                write: async <T extends Entity>({ entries }: WriteRequest<T>): Promise<WriteOutput<T>> => {
                    const results = entries.map((entry): WriteItemResult => {
                        const rawEntityId = (entry.item as { entityId?: unknown })?.entityId
                        const rawBaseVersion = (entry.item as { baseVersion?: unknown })?.baseVersion
                        return {
                            entryId: entry.entryId,
                            ok: true,
                            entityId: typeof rawEntityId === 'string' && rawEntityId.length ? rawEntityId : entry.entryId,
                            version: (
                                typeof rawBaseVersion === 'number'
                                && Number.isFinite(rawBaseVersion)
                                && rawBaseVersion > 0
                            )
                                ? rawBaseVersion + 1
                                : 1
                        }
                    })
                    return {
                        status: 'confirmed',
                        ...(results.length ? { results } : {})
                    }
                }
            }
        },
        routes: {
            [LOCAL_ROUTE]: {
                query: EXECUTOR_ID,
                write: EXECUTOR_ID
            }
        }
    })
}
