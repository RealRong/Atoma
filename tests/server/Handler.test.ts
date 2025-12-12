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
            action: 'query',
            queries: [{ resource: 'post', requestId: 'r1', params: {} }]
        }))

        expect(res.status).toBe(200)
        expect(adapter.findMany).toHaveBeenCalledWith('post', {})
        expect(res.body.results[0]).toMatchObject({ requestId: 'r1', data: [{ id: 1 }] })
    })

    it('当资源不在 allowList 时返回 403', async () => {
        const adapter = createAdapter()
        const handler = createHandler({ adapter, guardOptions: { allowList: ['comment'] } })

        const res = await handler(makeFetchLike({
            action: 'query',
            queries: [{ resource: 'post', params: {} }]
        }))

        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('ACCESS_DENIED')
    })

    it('maxLimit 会截断超出的 limit 并继续查询', async () => {
        const adapter = createAdapter([{ data: [] }])
        const handler = createHandler({ adapter, guardOptions: { maxLimit: 50 } })

        await handler(makeFetchLike({
            action: 'query',
            queries: [{ resource: 'comment', params: { limit: 200 } }]
        }))

        expect(adapter.findMany).toHaveBeenCalledWith('comment', { limit: 50 })
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
            action: 'query',
            queries: [{ resource: 'post', params: {} }]
        }))

        expect(res.status).toBe(200)
        expect(res.body.results[0].error).toMatchObject({ code: 'QUERY_FAILED' })
    })

    it('写操作 create 会调用 adapter.create 并返回 201', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            create: vi.fn(async () => ({ data: { id: 1, title: 'hi' } }))
        }
        const handler = createHandler({ adapter })

        const res = await handler(makeFetchLike({
            action: 'create',
            resource: 'post',
            payload: { title: 'hi' },
            requestId: 'r1'
        }))

        expect(adapter.create).toHaveBeenCalledWith('post', { title: 'hi' }, undefined)
        expect(res.status).toBe(201)
        expect(res.body.results[0]).toMatchObject({ requestId: 'r1', data: [{ id: 1, title: 'hi' }] })
    })

    it('bulkCreate 超过 maxBatchSize 会被拒绝', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(),
            isResourceAllowed: vi.fn(() => true),
            bulkCreate: vi.fn()
        }
        const handler = createHandler({ adapter, guardOptions: { maxBatchSize: 2 } })

        const res = await handler(makeFetchLike({
            action: 'bulkCreate',
            resource: 'post',
            payload: [{}, {}, {}]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('TOO_MANY_ITEMS')
    })
})
