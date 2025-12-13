import { describe, it, expect, vi } from 'vitest'
import { createHandler } from '../../src/server'
import type { IOrmAdapter, QueryResult } from '../../src/server'

const makeFetchLike = (body: any) => ({
    method: 'POST',
    url: 'http://localhost/batch',
    json: async () => body
})

const createAdapter = (results: QueryResult[] = [{ data: [] }]): IOrmAdapter => {
    const findMany = vi.fn(async () => results.shift() || { data: [] })
    return {
        findMany,
        isResourceAllowed: vi.fn(() => true)
    }
}

describe('createHandler', () => {
    it('执行 query 并返回 requestId 对应的数据', async () => {
        const adapter = createAdapter([{ data: [{ id: 1 }] }])
        const handler = createHandler({ adapter })

        const res = await handler(makeFetchLike({
            ops: [{
                opId: 'r1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: { page: { mode: 'offset', limit: 50, includeTotal: true } }
                }
            }]
        }))

        expect(res.status).toBe(200)
        expect(adapter.findMany).toHaveBeenCalledWith('post', { page: { mode: 'offset', limit: 50, includeTotal: true } })
        expect(res.body.results[0]).toMatchObject({ opId: 'r1', ok: true, data: [{ id: 1 }] })
    })

    it('当资源不在 allowList 时返回 403', async () => {
        const adapter = createAdapter()
        const handler = createHandler({ adapter, guardOptions: { allowList: ['comment'] } })

        const res = await handler(makeFetchLike({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: { resource: 'post', params: { page: { mode: 'offset', limit: 50, includeTotal: true } } }
            }]
        }))

        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('ACCESS_DENIED')
    })

    it('maxLimit 会截断超出的 limit 并继续查询', async () => {
        const adapter = createAdapter([{ data: [] }])
        const handler = createHandler({ adapter, guardOptions: { maxLimit: 50 } })

        await handler(makeFetchLike({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: { resource: 'comment', params: { page: { mode: 'offset', limit: 200, includeTotal: true } } }
            }]
        }))

        expect(adapter.findMany).toHaveBeenCalledWith('comment', { page: { mode: 'offset', limit: 50, includeTotal: true } })
    })

    it('查询失败时返回 error 字段而非抛出', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => {
                throw new Error('boom')
            }),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeFetchLike({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: { resource: 'post', params: { page: { mode: 'offset', limit: 50, includeTotal: true } } }
            }]
        }))

        expect(res.status).toBe(200)
        expect(res.body.results[0].error).toMatchObject({ code: 'QUERY_FAILED' })
    })

    it('写操作 bulkCreate 会调用 adapter.bulkCreate（/batch 固定 200）', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkCreate: vi.fn(async () => ({ data: [{ id: 1, title: 'hi' }] }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeFetchLike({
            ops: [{
                opId: 'r1',
                action: 'bulkCreate',
                resource: 'post',
                payload: [{ title: 'hi' }]
            }]
        }))

        expect(adapter.bulkCreate).toHaveBeenCalledWith('post', [{ title: 'hi' }], undefined)
        expect(res.status).toBe(200)
        expect(res.body.results[0]).toMatchObject({ opId: 'r1', ok: true, data: [{ id: 1, title: 'hi' }] })
    })

    it('bulkCreate 超过 maxBatchSize 会被拒绝', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkCreate: vi.fn()
        }
        const handler = createHandler({ adapter, guardOptions: { maxBatchSize: 2 } })

        const res = await handler(makeFetchLike({
            ops: [{
                opId: 'b1',
                action: 'bulkCreate',
                resource: 'post',
                payload: [{}, {}, {}]
            }]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('TOO_MANY_ITEMS')
    })

    it('当 adapter 未实现 action 时，/batch 返回 200 + results[i].error', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeFetchLike({
            ops: [{
                opId: 'p1',
                action: 'bulkPatch',
                resource: 'post',
                payload: [{ id: 1, patches: [{ op: 'replace', path: ['title'], value: 'x' }] }]
            }]
        }))

        expect(res.status).toBe(200)
        expect(res.body.results[0].error.code).toBe('ADAPTER_NOT_IMPLEMENTED')
    })

    it('允许 query 与 write ops 混合：互不影响并保持 results 顺序', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1 }] })),
            isResourceAllowed: vi.fn(() => true),
            bulkCreate: vi.fn(async () => ({ data: [{ id: 2 }] }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeFetchLike({
            ops: [
                {
                    opId: 'q1',
                    action: 'query',
                    query: { resource: 'post', params: { page: { mode: 'offset', limit: 1, includeTotal: true } } }
                },
                {
                    opId: 'c1',
                    action: 'bulkCreate',
                    resource: 'post',
                    payload: [{ title: 'hi' }]
                }
            ]
        }))

        expect(res.status).toBe(200)
        expect(res.body.results).toHaveLength(2)
        expect(res.body.results[0]).toMatchObject({ opId: 'q1', ok: true, data: [{ id: 1 }] })
        expect(res.body.results[1]).toMatchObject({ opId: 'c1', ok: true, data: [{ id: 2 }] })
    })
})
