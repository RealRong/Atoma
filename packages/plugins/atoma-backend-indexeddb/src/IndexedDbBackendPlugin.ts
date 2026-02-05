import type { Table } from 'dexie'
import { Protocol } from 'atoma-protocol'
import type { ClientPlugin, PluginContext, ReadRequest, Register } from 'atoma-types/client'
import type { PersistResult } from 'atoma-types/runtime'
import { IndexedDBOpsClient } from './IndexedDBOpsClient'

export type IndexedDbBackendPluginOptions = Readonly<{
    tables: Record<string, Table<any, string>>
}>

async function queryViaOps(ctx: PluginContext, req: ReadRequest) {
    const opId = Protocol.ids.createOpId('q', { now: ctx.runtime.now })
    const op = Protocol.ops.build.buildQueryOp({
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
    const data = Protocol.ops.validate.assertQueryResultData((result as any).data)
    return {
        data: Array.isArray((data as any)?.data) ? ((data as any).data as unknown[]) : [],
        pageInfo: (data as any)?.pageInfo
    }
}

export function indexedDbBackendPlugin(options: IndexedDbBackendPluginOptions): ClientPlugin {
    return {
        id: 'indexeddb',
        register: (ctx: PluginContext, register: Register) => {
            const opsClient = new IndexedDBOpsClient({
                tableForResource: (resource) => {
                    const tbl = (options.tables as any)[resource]
                    if (tbl) return tbl as Table<any, string>
                    throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
                }
            })

            register('io', async (req) => {
                return await opsClient.executeOps({
                    ops: req.ops,
                    meta: req.meta,
                    ...(req.signal ? { signal: req.signal } : {})
                })
            }, { priority: 1000 })

            register('read', async (req: ReadRequest) => {
                return await queryViaOps(ctx, req)
            }, { priority: 1000 })

            register('persist', async (req, _ctx, _next): Promise<PersistResult<any>> => {
                const results = await ctx.runtime.io.executeOps({
                    ops: req.writeOps as any
                })
                return {
                    status: 'confirmed',
                    ...(results.length ? { results } : {})
                }
            }, { priority: 1000 })
        }
    }
}
