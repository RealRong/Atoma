import { Protocol } from 'atoma-protocol'
import type { PersistResult } from 'atoma-core'
import { executeWriteOps } from 'atoma-core'
import { createHttpEndpoint } from '../backend/http/createHttpEndpoint'
import { ClientPlugin } from '../plugins/ClientPlugin'
import type { PluginContext, ReadRequest, Register } from '../plugins/types'

export class HttpBackendPlugin extends ClientPlugin {
    readonly id: string
    private readonly baseURL: string

    constructor(args: { baseURL: string }) {
        super()
        this.baseURL = String(args.baseURL ?? '').trim()
        if (!this.baseURL) throw new Error('[Atoma] HttpBackendPlugin: baseURL 必填')
        this.id = `http:${this.baseURL}`
    }

    setup(ctx: PluginContext, register: Register) {
        const endpoint = createHttpEndpoint({ baseURL: this.baseURL, role: 'ops' })
        ctx.endpoints.register(endpoint)

        register('io', async (req) => {
            return await endpoint.driver.executeOps(req)
        }, { priority: 1000 })

        register('read', async (req: ReadRequest, _ctx, _next) => {
            return await this.queryViaOps(ctx, req)
        }, { priority: 1000 })

        register('persist', async (req, _ctx, _next): Promise<PersistResult<any>> => {
            const normalized = await executeWriteOps<any>({
                clientRuntime: ctx.runtime as any,
                handle: req.handle,
                ops: req.writeOps as any,
                context: req.context
            })
            return {
                status: 'confirmed',
                ...(normalized.ack ? { ack: normalized.ack } : {})
            }
        }, { priority: 1000 })
    }

    private queryViaOps = async (ctx: PluginContext, req: ReadRequest) => {
        const opId = Protocol.ids.createOpId('q', { now: ctx.runtime.now })
        const op = Protocol.ops.build.buildQueryOp({
            opId,
            resource: String(req.storeName),
            query: req.query
        })
        const results = await ctx.runtime.io.executeOps({
            ops: [op],
            ...(req.context ? { context: req.context } : {}),
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
            pageInfo: (data as any)?.pageInfo,
            ...(data && (data as any).explain !== undefined ? { explain: (data as any).explain } : {})
        }
    }
}
