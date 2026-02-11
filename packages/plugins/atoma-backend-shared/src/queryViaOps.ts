import { getOpsClient } from 'atoma-types/client/ops'
import { createOpId, buildQueryOp } from 'atoma-types/protocol-tools'
import type { PluginContext, ReadRequest } from 'atoma-types/client/plugins'
import { parseQueryOpResult } from './opsResult'

export async function queryViaOps(ctx: PluginContext, req: ReadRequest) {
    const opsClient = getOpsClient(ctx.capabilities)
    if (!opsClient) {
        throw new Error('[Atoma] queryViaOps: missing client.ops capability')
    }

    const opId = createOpId('q', { now: ctx.runtime.now })
    const op = buildQueryOp({
        opId,
        resource: String(req.storeName),
        query: req.query
    })
    const output = await opsClient.executeOps({
        ops: [op],
        ...(req.signal ? { signal: req.signal } : {}),
        meta: {
            v: 1,
            clientTimeMs: ctx.runtime.now(),
            requestId: opId,
            traceId: opId
        }
    })

    const data = parseQueryOpResult(output.results)
    return {
        data: data.data,
        ...(data.pageInfo !== undefined ? { pageInfo: data.pageInfo } : {})
    }
}
