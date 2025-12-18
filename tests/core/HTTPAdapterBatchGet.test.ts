import { describe, it, expect, vi, afterEach } from 'vitest'
import { HTTPAdapter } from '../../src/adapters/HTTPAdapter'
import { createCoreStore } from '../../src/core/createCoreStore'

describe('HTTPAdapter（batch 启用时 get/getAll 走 /batch）', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('get 会通过 batch 发送 query', async () => {
        const fetchFn = vi.fn(async (input: any, init: any) => {
            const body = JSON.parse(init.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    results: body.ops.map((op: any) => ({
                        opId: op.opId,
                        ok: true,
                        data: [{ id: 1 }]
                    }))
                })
            }
        })

        vi.stubGlobal('fetch', fetchFn as any)

        const adapter = new HTTPAdapter<any>({
            baseURL: 'http://localhost',
            resourceName: 'post',
            batch: true
        })

        const res = await adapter.get(1)
        expect(res).toMatchObject({ id: 1 })

        expect(fetchFn).toHaveBeenCalledTimes(1)
        expect(String(fetchFn.mock.calls[0][0])).toContain('/batch')
        const sent = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(sent.ops[0].action).toBe('query')
        expect(sent.ops[0].query.resource).toBe('post')
        expect(sent.ops[0].query.params.page).toMatchObject({ mode: 'offset', limit: 1, includeTotal: false })
    })

    it('store.getOneById 传 traceId 时 batch 请求带 trace headers', async () => {
        const fetchFn = vi.fn(async (_input: any, init: any) => {
            const body = JSON.parse(init.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    results: body.ops.map((op: any) => ({
                        opId: op.opId,
                        ok: true,
                        data: [{ id: 1 }]
                    }))
                })
            }
        })

        vi.stubGlobal('fetch', fetchFn as any)

        const adapter = new HTTPAdapter<any>({
            baseURL: 'http://localhost',
            resourceName: 'post',
            batch: true
        })

        const store = createCoreStore<any>({
            name: 'posts',
            adapter
        })

        const item = await store.getOneById(1, { traceId: 't_test' })
        expect(item).toMatchObject({ id: 1 })

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const init = fetchFn.mock.calls[0][1] as any
        const headers = init.headers as Record<string, string>
        expect(headers['x-atoma-trace-id'] || headers['X-Atoma-Trace-Id']).toBe('t_test')
        expect(headers['x-atoma-request-id'] || headers['X-Atoma-Request-Id']).toBe('r_t_test_1')

        const sent = JSON.parse(init.body)
        expect(sent.traceId).toBe('t_test')
        expect(sent.requestId).toBe('r_t_test_1')
    })
})
