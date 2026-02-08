import { createOpId, buildQueryOp, assertQueryResultData } from 'atoma-types/protocol-tools'
import type { PluginContext, ReadRequest } from 'atoma-types/client'

export async function queryViaOps(ctx: PluginContext, req: ReadRequest) {
    const opId = createOpId('q', { now: ctx.runtime.now })
    const op = buildQueryOp({
        opId,
        resource: String(req.storeName),
        query: req.query
    })
    const results = await ctx.runtime.io.executeOps({
        ops: [op],
        ...(req.signal ? { signal: req.signal } : {})
    })
    const result = results[0]
    if (!result) throw new Error('[Atoma] Missing query result')
    if (!(result as any).ok) {
        const msg = ((result as any).error && typeof (result as any).error.message === 'string')
            ? (result as any).error.message
            : '[Atoma] Query failed'
        throw new Error(msg)
    }
    const data = assertQueryResultData((result as any).data)
    return {
        data: Array.isArray((data as any)?.data) ? ((data as any).data as unknown[]) : [],
        pageInfo: (data as any)?.pageInfo
    }
}
