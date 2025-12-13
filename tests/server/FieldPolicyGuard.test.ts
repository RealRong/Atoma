import { describe, it, expect, vi } from 'vitest'
import { createHandler } from '../../src/server'
import type { IOrmAdapter, QueryResult } from '../../src/server'

const makeBatchIncoming = (body: any) => ({
    method: 'POST',
    url: 'http://localhost/batch',
    json: async () => body
})

const makeRestIncoming = (args: { method: string; url: string; body?: any }) => ({
    method: args.method,
    url: args.url,
    json: async () => args.body
})

const createAdapter = (results: QueryResult[] = [{ data: [] }]): IOrmAdapter => {
    const findMany = vi.fn(async () => results.shift() || { data: [] })
    return {
        findMany,
        isResourceAllowed: vi.fn(() => true)
    }
}

describe('字段级安全边界（GuardOptions.policy）', () => {
    it('未配置 policy：where/orderBy/select 全部放行', async () => {
        const adapter = createAdapter([{ data: [{ id: 1 }] }])
        const handler = createHandler({ adapter })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { passwordHash: 'x' },
                        orderBy: [{ field: 'passwordHash', direction: 'desc' }],
                        select: { id: true, passwordHash: true },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(200)
        expect(adapter.findMany).toHaveBeenCalled()
    })

    it('policy.allow：where 字段不在 allow 内 → 422 INVALID_QUERY', async () => {
        const adapter = createAdapter()
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: { where: ['title'] }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { passwordHash: 'x' },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
        expect(res.body.error.message).toContain('Field not allowed')
    })

    it('policy.deny：where 命中 deny → 422 INVALID_QUERY', async () => {
        const adapter = createAdapter()
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: { where: { deny: ['passwordHash'] } }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { passwordHash: 'x' },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
    })

    it('deny 优先：allow + deny 同时存在时 deny 命中仍拒绝', async () => {
        const adapter = createAdapter()
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: {
                    where: { allow: ['passwordHash'], deny: ['passwordHash'] }
                }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { passwordHash: 'x' },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_QUERY')
    })

    it('orderBy 字段不允许 → 422 INVALID_ORDER_BY', async () => {
        const adapter = createAdapter()
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: { orderBy: ['createdAt'] }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        orderBy: [{ field: 'passwordHash', direction: 'desc' }],
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe('INVALID_ORDER_BY')
    })

    it('select 未传：放行（默认可返回全字段）', async () => {
        const adapter = createAdapter([{ data: [{ id: 1 }] }])
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: { select: ['id'] }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { title: 'x' },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(200)
    })

    it('where.id 作为系统字段永远放行：即使 where.allow 不包含 id 也不应阻断 REST GET /:resource/:id', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1, title: 'hi' }] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: { where: ['title'] }
            }
        })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post/1'
        }))

        expect(res.status).toBe(200)
        expect(res.body.data).toMatchObject({ id: 1 })
        expect(adapter.findMany).toHaveBeenCalled()
    })

    it('where.id 系统字段：即使 deny 包含 id 也放行', async () => {
        const adapter: IOrmAdapter = {
            findMany: vi.fn(async () => ({ data: [{ id: 1 }] } satisfies QueryResult)),
            isResourceAllowed: vi.fn(() => true)
        }
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: { where: { deny: ['id'] } }
            }
        })

        const res = await handler(makeRestIncoming({
            method: 'GET',
            url: 'http://localhost/post/1'
        }))

        expect(res.status).toBe(200)
    })

    it('policy resolver 返回 undefined：默认放行', async () => {
        const adapter = createAdapter([{ data: [{ id: 1 }] }])
        const handler = createHandler({
            adapter,
            guardOptions: {
                policy: ({ resource }) => resource === 'post' ? undefined : { where: ['x'] }
            }
        })

        const res = await handler(makeBatchIncoming({
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        where: { passwordHash: 'x' },
                        page: { mode: 'offset', limit: 50, includeTotal: true }
                    }
                }
            }]
        }))

        expect(res.status).toBe(200)
    })
})
