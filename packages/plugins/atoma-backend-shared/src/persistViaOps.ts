import type { PluginContext } from 'atoma-types/client'
import type { PersistRequest, PersistResult } from 'atoma-types/runtime'

export async function persistViaOps(ctx: PluginContext, req: PersistRequest<any>): Promise<PersistResult<any>> {
    const results = await ctx.runtime.io.executeOps({
        ops: req.writeOps as any,
        ...(req.signal ? { signal: req.signal } : {})
    })

    return {
        status: 'confirmed',
        ...(results.length ? { results } : {})
    }
}
