import { toStandardError } from '../../error'
import type { AtomaOpPluginContext, AtomaOpPluginResult, AtomaServerPluginRuntime, AtomaServerRoute } from '../../config'
import { Protocol } from '#protocol'
import type { OperationResult, QueryOp, QueryResultData } from '#protocol'
import type { IOrmAdapter, QueryResult } from '../../adapters/ports'

type TraceMeta = { traceId?: string; requestId?: string; opId: string }

type QueryOkResult = Extract<OperationResult<QueryResultData>, { ok: true }>

function toQueryOk(opId: string, res?: QueryResult): QueryOkResult {
    return {
        opId,
        ok: true,
        data: { items: res?.data ?? [], ...(res?.pageInfo ? { pageInfo: res.pageInfo } : {}) }
    }
}

function toQueryFail(opId: string, err: unknown, trace: TraceMeta): OperationResult {
    return {
        opId,
        ok: false,
        error: Protocol.error.withTrace(toStandardError(err, 'QUERY_FAILED'), trace)
    }
}

export async function executeQueryOps<Ctx>(args: {
    adapter: IOrmAdapter
    queryOps: QueryOp[]
    hasOpPlugins: boolean
    route: AtomaServerRoute
    pluginRuntime: AtomaServerPluginRuntime<Ctx>
    runOpPlugins: (ctx: AtomaOpPluginContext<Ctx>, next: () => Promise<AtomaOpPluginResult>) => Promise<AtomaOpPluginResult>
    traceMetaForOpId: (opId: string) => TraceMeta
    resultsByOpId: Map<string, OperationResult>
}) {
    if (!args.queryOps.length) return

    const entries = args.queryOps.map(q => ({ opId: q.opId, resource: q.query.resource, params: q.query.params }))
    const queryOpById = new Map(args.queryOps.map(q => [q.opId, q] as const))
    let didBatch = false

    if (!args.hasOpPlugins && typeof args.adapter.batchFindMany === 'function') {
        try {
            const resList = await args.adapter.batchFindMany(entries.map(e => ({ resource: e.resource, params: e.params })))
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i]
                args.resultsByOpId.set(e.opId, toQueryOk(e.opId, resList[i] as QueryResult | undefined))
            }
            didBatch = true
        } catch {
            // fallback to per-query execution to preserve per-op error contract
        }
    }

    if (didBatch) return

    if (!args.hasOpPlugins) {
        const settled = await Promise.allSettled(entries.map(e => args.adapter.findMany(e.resource, e.params)))
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            const res = settled[i]
            if (res.status === 'fulfilled') {
                args.resultsByOpId.set(e.opId, toQueryOk(e.opId, res.value))
                continue
            }
            args.resultsByOpId.set(e.opId, toQueryFail(e.opId, res.reason, args.traceMetaForOpId(e.opId)))
        }
        return
    }

    await Promise.all(entries.map(async (e) => {
        const op = queryOpById.get(e.opId)
        const pluginResult = await args.runOpPlugins({
            opId: e.opId,
            kind: 'query',
            resource: e.resource,
            op,
            route: args.route,
            runtime: args.pluginRuntime
        }, async () => {
            try {
                const res = await args.adapter.findMany(e.resource, e.params)
                return { ok: true, data: toQueryOk(e.opId, res).data }
            } catch (err) {
                return { ok: false, error: err }
            }
        })

        if (pluginResult.ok) {
            args.resultsByOpId.set(e.opId, { opId: e.opId, ok: true, data: pluginResult.data })
            return
        }

        args.resultsByOpId.set(e.opId, toQueryFail(e.opId, pluginResult.error, args.traceMetaForOpId(e.opId)))
    }))
}
