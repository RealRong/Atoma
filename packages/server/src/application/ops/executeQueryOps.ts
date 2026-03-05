import { withErrorTrace } from '@atoma-js/types/protocol-tools'
import type { QueryOp, QueryResultData, RemoteOpResult } from '@atoma-js/types/protocol'
import type {
    AtomaOpMiddlewareContext,
    AtomaOpMiddlewareResult,
    AtomaServerPluginRuntime,
    AtomaServerRoute
} from '../../config'
import type { IOrmAdapter, QueryResult } from '../../adapters/ports'
import { toStandard } from '../../shared/errors/standardError'

type TraceMeta = {
    traceId?: string
    requestId?: string
    opId: string
}

type QueryOkResult = Extract<RemoteOpResult<QueryResultData>, { ok: true }>

function toQueryOk(opId: string, res?: QueryResult): QueryOkResult {
    return {
        opId,
        ok: true,
        data: {
            data: res?.data ?? [],
            ...(res?.pageInfo ? { pageInfo: res.pageInfo } : {})
        }
    }
}

function toQueryFail(opId: string, error: unknown, trace: TraceMeta): RemoteOpResult {
    return {
        opId,
        ok: false,
        error: withErrorTrace(toStandard(error, 'QUERY_FAILED'), trace)
    }
}

export async function executeApplicationQueryOps<Ctx>(args: {
    adapter: IOrmAdapter
    queryOps: QueryOp[]
    hasOpMiddlewares: boolean
    route: AtomaServerRoute
    pluginRuntime: AtomaServerPluginRuntime<Ctx>
    runOpMiddlewares: (
        ctx: AtomaOpMiddlewareContext<Ctx>,
        next: () => Promise<AtomaOpMiddlewareResult>
    ) => Promise<AtomaOpMiddlewareResult>
    traceMetaForOpId: (opId: string) => TraceMeta
    resultsByOpId: Map<string, RemoteOpResult>
}) {
    if (!args.queryOps.length) return

    const entries = args.queryOps.map(op => ({
        opId: op.opId,
        resource: op.query.resource,
        query: op.query.query
    }))
    const opById = new Map(args.queryOps.map(op => [op.opId, op] as const))
    let didBatch = false

    if (!args.hasOpMiddlewares && typeof args.adapter.batchFindMany === 'function') {
        try {
            const batch = await args.adapter.batchFindMany(entries.map(entry => ({
                resource: entry.resource,
                query: entry.query
            })))
            if (batch.length !== entries.length) {
                throw new Error(`batchFindMany result size mismatch: expected ${entries.length}, got ${batch.length}`)
            }

            entries.forEach((entry, index) => {
                args.resultsByOpId.set(entry.opId, toQueryOk(entry.opId, batch[index] as QueryResult | undefined))
            })
            didBatch = true
        } catch {
            // fallback 到逐条执行，保留每个 op 的错误隔离语义
        }
    }
    if (didBatch) return

    if (!args.hasOpMiddlewares) {
        const settled = await Promise.allSettled(entries.map(entry => args.adapter.findMany(entry.resource, entry.query)))
        entries.forEach((entry, index) => {
            const result = settled[index]
            if (result.status === 'fulfilled') {
                args.resultsByOpId.set(entry.opId, toQueryOk(entry.opId, result.value))
                return
            }
            args.resultsByOpId.set(entry.opId, toQueryFail(entry.opId, result.reason, args.traceMetaForOpId(entry.opId)))
        })
        return
    }

    await Promise.all(entries.map(async (entry) => {
        const middlewareResult = await args.runOpMiddlewares({
            opId: entry.opId,
            kind: 'query',
            resource: entry.resource,
            op: opById.get(entry.opId),
            route: args.route,
            runtime: args.pluginRuntime
        }, async () => {
            try {
                const result = await args.adapter.findMany(entry.resource, entry.query)
                return { ok: true, data: toQueryOk(entry.opId, result).data }
            } catch (error) {
                return { ok: false, error }
            }
        })

        if (middlewareResult.ok) {
            args.resultsByOpId.set(entry.opId, { opId: entry.opId, ok: true, data: middlewareResult.data })
            return
        }

        args.resultsByOpId.set(
            entry.opId,
            toQueryFail(entry.opId, middlewareResult.error, args.traceMetaForOpId(entry.opId))
        )
    }))
}
