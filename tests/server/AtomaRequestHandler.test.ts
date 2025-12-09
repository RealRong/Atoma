import { describe, it, expect, vi } from 'vitest'
import { AtomaRequestHandler } from '../../src/server'
import type { IOrmAdapter, QueryResult } from '../../src/server'

const createAdapter = (results: QueryResult[] = [{ data: [] }]): IOrmAdapter => {
    const findMany = vi.fn(async () => results.shift() || { data: [] })
    return {
        findMany,
        isResourceAllowed: vi.fn(() => true)
    }
}

describe('AtomaRequestHandler', () => {
    it('执行每条查询并返回 requestId 对应的数据', async () => {
        const adapter = createAdapter([{ data: [{ id: 1 }] }])
        const handler = new AtomaRequestHandler({ adapter })

        const res = await handler.handle({
            action: 'query',
            queries: [{ resource: 'post', requestId: 'r1', params: {} }]
        })

        expect(adapter.findMany).toHaveBeenCalledWith('post', {})
        expect(res.results[0]).toMatchObject({ requestId: 'r1', data: [{ id: 1 }] })
    })

    it('当资源不在 allowList 时抛出错误', async () => {
        const adapter = createAdapter()
        const handler = new AtomaRequestHandler({ adapter, allowList: ['comment'] })

        await expect(() =>
            handler.handle({
                action: 'query',
                queries: [{ resource: 'post', params: {} }]
            })
        ).rejects.toThrow(/denied/)
    })

    it('maxLimit 会截断超出的 limit 并继续查询', async () => {
        const adapter = createAdapter([{ data: [] }])
        const handler = new AtomaRequestHandler({ adapter, maxLimit: 50 })

        await handler.handle({
            action: 'query',
            queries: [{ resource: 'comment', params: { limit: 200 } }]
        })

        expect(adapter.findMany).toHaveBeenCalledWith('comment', { limit: 50 })
    })

    it('查询失败时返回 error 字段而非抛出', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => {
                throw new Error('boom')
            }),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = new AtomaRequestHandler({ adapter })

        const res = await handler.handle({
            action: 'query',
            queries: [{ resource: 'post', params: {} }]
        })

        expect(res.results[0].error).toMatchObject({ code: 'QUERY_FAILED' })
    })
})
