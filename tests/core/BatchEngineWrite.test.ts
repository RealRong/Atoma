import { describe, it, expect, vi } from 'vitest'
import { BatchEngine } from '../../src/batch/BatchEngine'

const createFetch = (buildResponse: (requestBody: any) => any) => {
    const fetchFn = vi.fn(async (_url: any, init: any) => {
        const req = JSON.parse(init.body)
        const resBody = buildResponse(req)
        return {
            ok: true,
            json: async () => resBody
        }
    })
    return { fetchFn }
}

describe('BatchEngine write batching（op-list 协议）', () => {
    it('合并多次 create 为一条 bulkCreate', async () => {
        const { fetchFn } = createFetch((req) => ({
            results: req.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
        }))
        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })

        await Promise.all([
            engine.enqueueCreate('post', { id: 1, data: { title: 'a' } }),
            engine.enqueueCreate('post', { id: 2, data: { title: 'b' } })
        ])

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops[0].action).toBe('bulkCreate')
        expect(body.ops[0].payload).toHaveLength(2)
    })

    it('合并多次 put 为一条 bulkUpdate', async () => {
        const { fetchFn } = createFetch((req) => ({
            results: req.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
        }))
        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })

        await Promise.all([
            engine.enqueueUpdate('post', { id: 1, data: { title: 'a' } }),
            engine.enqueueUpdate('post', { id: 2, data: { title: 'b' } })
        ])

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops[0].action).toBe('bulkUpdate')
        expect(body.ops[0].payload).toHaveLength(2)
    })

    it('超过 maxBatchSize 会被切片为多个 op（同一次请求内）', async () => {
        const { fetchFn } = createFetch((req) => ({
            results: req.ops.map((op: any) => ({ opId: op.opId, ok: true, data: [] }))
        }))
        const engine = new BatchEngine({ fetchFn, endpoint: '/batch', maxBatchSize: 1 })

        await Promise.all([
            engine.enqueueUpdate('post', { id: 1, data: { title: 'a' } }),
            engine.enqueueUpdate('post', { id: 2, data: { title: 'b' } })
        ])

        expect(fetchFn).toHaveBeenCalledTimes(1)
        const body = JSON.parse((fetchFn.mock.calls[0][1] as any).body)
        expect(body.ops).toHaveLength(2)
    })

    it('partialFailures 会精确 reject 对应项', async () => {
        const { fetchFn } = createFetch((req) => ({
            results: [{
                opId: req.ops[0].opId,
                ok: true,
                data: [],
                partialFailures: [{ index: 1, error: { code: 'FAIL' } }]
            }]
        }))
        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })

        const first = engine.enqueueUpdate('post', { id: 1, data: { title: 'ok' } })
        const second = engine.enqueueUpdate('post', { id: 2, data: { title: 'bad' } })

        await expect(first).resolves.toBeUndefined()
        await expect(second).rejects.toMatchObject({ code: 'FAIL' })
    })

    it('create partialFailures 只拒绝对应项', async () => {
        const { fetchFn } = createFetch((req) => ({
            results: [{
                opId: req.ops[0].opId,
                ok: true,
                data: [],
                partialFailures: [{ index: 0, error: { code: 'FAIL_CREATE' } }]
            }]
        }))
        const engine = new BatchEngine({ fetchFn, endpoint: '/batch' })

        const first = engine.enqueueCreate('post', { id: 1, data: { title: 'bad' } })
        const second = engine.enqueueCreate('post', { id: 2, data: { title: 'ok' } })

        await expect(first).rejects.toMatchObject({ code: 'FAIL_CREATE' })
        await expect(second).resolves.toBeUndefined()
    })
})
