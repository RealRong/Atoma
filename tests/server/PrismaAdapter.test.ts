import { describe, it, expect, vi } from 'vitest'
import { AtomaPrismaAdapter } from '../../src/server/prisma'

class FakeDelegate {
    lastArgs: any
    constructor(private readonly data: any[] = [{ id: 1 }], private readonly total = 1) {}

    findMany = vi.fn(async (args: any) => {
        this.lastArgs = args
        return this.data
    })

    count = vi.fn(async (args: any) => {
        this.lastArgs = { ...(this.lastArgs || {}), countArgs: args }
        return this.total
    })
}

const createClient = (delegate: FakeDelegate, withTransaction = false) => {
    const client: any = { comment: delegate }
    if (withTransaction) {
        client.$transaction = vi.fn(async (ops: Promise<any>[]) => Promise.all(ops))
    }
    return client
}

describe('AtomaPrismaAdapter', () => {
    it('将 QueryParams 映射到 Prisma findMany/count', async () => {
        const delegate = new FakeDelegate([{ id: 1 }, { id: 2 }], 20)
        const client = createClient(delegate)
        const adapter = new AtomaPrismaAdapter(client)

        const res = await adapter.findMany('comment', {
            where: { postId: { in: [1, 2] }, score: { gt: 10 }, title: { contains: 'abc' } },
            orderBy: { field: 'createdAt', direction: 'desc' },
            limit: 5,
            offset: 10,
            select: { id: true, title: true },
            cursor: 100
        })

        expect(res.pageInfo?.total).toBe(20)
        expect(delegate.findMany).toHaveBeenCalled()
        expect(delegate.count).toHaveBeenCalled()
        expect(delegate.lastArgs.where).toMatchObject({
            postId: { in: [1, 2] },
            score: { gt: 10 },
            title: { contains: 'abc' },
            id: { gt: 100 }
        })
        expect(delegate.lastArgs.orderBy[0]).toEqual({ createdAt: 'desc' })
        expect(delegate.lastArgs.take).toBe(5)
        expect(delegate.lastArgs.skip).toBe(10)
        expect(delegate.lastArgs.select).toMatchObject({ id: true, title: true })
    })

    it('cursor 追加到 cursorField，当已存在同字段条件时合并', async () => {
        const delegate = new FakeDelegate()
        const client = createClient(delegate)
        const adapter = new AtomaPrismaAdapter(client, { cursorField: 'createdAt' })

        await adapter.findMany('comment', {
            where: { createdAt: { lt: 200 } },
            cursor: 100
        })

        expect(delegate.lastArgs.where.createdAt).toMatchObject({ lt: 200, gt: 100 })
    })

    it('isResourceAllowed 根据 client 上的模型是否存在', () => {
        const client = createClient(new FakeDelegate())
        const adapter = new AtomaPrismaAdapter(client)

        expect(adapter.isResourceAllowed('comment')).toBe(true)
        expect(adapter.isResourceAllowed('post')).toBe(false)
    })

    it('batchFindMany 默认走 $transaction，若存在', async () => {
        const delegate = new FakeDelegate()
        const client = createClient(delegate, true)
        const adapter = new AtomaPrismaAdapter(client)

        await adapter.batchFindMany([
            { resource: 'comment', params: { limit: 1 } },
            { resource: 'comment', params: { limit: 2 } }
        ])

        expect(client.$transaction).toHaveBeenCalled()
    })

    it('bulkCreate 在非事务模式下收集 partialFailures', async () => {
        const delegate = {
            findMany: vi.fn(async () => []),
            create: vi.fn(async ({ data }: any) => {
                if (data.fail) throw Object.assign(new Error('boom'), { code: 'FAIL' })
                return data
            })
        }
        const client: any = { post: delegate }
        const adapter = new AtomaPrismaAdapter(client)

        const res = await adapter.bulkCreate('post', [
            { id: 1 },
            { id: 2, fail: true },
            { id: 3 }
        ])

        expect(delegate.create).toHaveBeenCalledTimes(3)
        expect(res.data).toHaveLength(2)
        expect(res.partialFailures?.[0]).toMatchObject({ index: 1 })
    })
})
