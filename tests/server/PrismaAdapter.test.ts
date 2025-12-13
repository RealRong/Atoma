import { describe, it, expect, vi } from 'vitest'
import { AtomaPrismaAdapter } from '../../src/server/prisma'
import { decodeCursorToken, encodeCursorToken } from '../../src/server/adapters/shared/keyset'

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

    update = vi.fn(async (args: any) => {
        this.lastArgs = { ...(this.lastArgs || {}), updateArgs: args }
        const id = args?.where?.id
        const base = this.data.find((x: any) => x.id === id)
        if (!base) throw new Error('Not found')
        const next = { ...base, ...(args?.data || {}) }
        // 模拟“更新后返回记录”
        this.data.splice(this.data.indexOf(base), 1, next)
        return next
    })
}

const createClient = (delegate: FakeDelegate, withTransaction = false) => {
    const client: any = { comment: delegate }
    if (withTransaction) {
        client.$transaction = vi.fn(async (arg: any) => {
            if (Array.isArray(arg)) return Promise.all(arg)
            return arg(client)
        })
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
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            page: { mode: 'offset', limit: 5, offset: 10, includeTotal: true },
            select: { id: true, title: true },
        })

        expect(res.pageInfo?.total).toBe(20)
        expect(delegate.findMany).toHaveBeenCalled()
        expect(delegate.count).toHaveBeenCalled()
        expect(delegate.lastArgs.where).toMatchObject({
            postId: { in: [1, 2] },
            score: { gt: 10 },
            title: { contains: 'abc' }
        })
        expect(delegate.lastArgs.orderBy[0]).toEqual({ createdAt: 'desc' })
        // 稳定排序：自动追加 id asc
        expect(delegate.lastArgs.orderBy[1]).toEqual({ id: 'asc' })
        expect(delegate.lastArgs.take).toBe(5)
        expect(delegate.lastArgs.skip).toBe(10)
        // 为 cursor 预留稳定排序字段（createdAt/id），即使用户没选也会补齐
        expect(delegate.lastArgs.select).toMatchObject({ id: true, title: true, createdAt: true })
    })

    it('cursor 分页会生成 keyset where，并返回 cursor token', async () => {
        const delegate = new FakeDelegate([
            { id: 1, createdAt: 10, title: 'a' },
            { id: 2, createdAt: 20, title: 'b' },
            { id: 3, createdAt: 30, title: 'c' }
        ], 3)
        const client = createClient(delegate)
        const adapter = new AtomaPrismaAdapter(client)

        const after = encodeCursorToken([20, 2]) // orderBy: createdAt desc + id asc（这里只测 token 结构，不强调语义）
        const res = await adapter.findMany('comment', {
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            page: { mode: 'cursor', limit: 2, after },
            select: { id: true, title: true }
        })

        expect(delegate.findMany).toHaveBeenCalled()
        expect(delegate.lastArgs.take).toBe(3)
        expect(delegate.lastArgs.where.OR).toBeTruthy()
        expect(res.pageInfo?.cursor).toBeTruthy()
        expect(res.pageInfo?.hasNext).toBe(true)
        expect(res.data).toHaveLength(2)

        // token 可解码
        const decoded = decodeCursorToken(res.pageInfo?.cursor as string)
        expect(Array.isArray(decoded)).toBe(true)
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
            { resource: 'comment', params: { page: { mode: 'offset', limit: 1, includeTotal: true } } },
            { resource: 'comment', params: { page: { mode: 'offset', limit: 2, includeTotal: true } } }
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

    it('patch 会应用 immer patches 并通过 update 写回（支持 path 前缀为 id）', async () => {
        const delegate = new FakeDelegate([{ id: 1, title: 'old', body: 'b' }], 1)
        const client = createClient(delegate)
        const adapter = new AtomaPrismaAdapter(client)

        const res = await adapter.patch('comment', {
            id: 1,
            patches: [
                { op: 'replace', path: [1, 'title'], value: 'new' },
                { op: 'replace', path: [1, 'body'], value: 'bb' }
            ]
        })

        expect(delegate.findMany).toHaveBeenCalled()
        expect(delegate.update).toHaveBeenCalled()
        expect(res.data).toMatchObject({ id: 1, title: 'new', body: 'bb' })
        // update 的 data 不应携带 id
        expect(delegate.lastArgs.updateArgs.data.id).toBeUndefined()
    })

    it('bulkPatch 在非事务模式下收集 partialFailures', async () => {
        const delegate = new FakeDelegate([{ id: 1, title: 't1' }], 1)
        const client = createClient(delegate)
        const adapter = new AtomaPrismaAdapter(client)

        const res = await adapter.bulkPatch('comment', [
            { id: 1, patches: [{ op: 'replace', path: [1, 'title'], value: 'new' }] },
            { id: 2, patches: [{ op: 'replace', path: [2, 'title'], value: 'x' }] }
        ])

        expect(res.data).toHaveLength(1)
        expect(res.data[0]).toMatchObject({ id: 1, title: 'new' })
        expect(res.partialFailures?.[0]).toMatchObject({ index: 1 })
    })

    it('patch 在 transaction=true 且存在 $transaction 时会走事务回调', async () => {
        const delegate = new FakeDelegate([{ id: 1, title: 'old' }], 1)
        const client = createClient(delegate, true)
        const adapter = new AtomaPrismaAdapter(client)

        await adapter.patch('comment', {
            id: 1,
            patches: [{ op: 'replace', path: [1, 'title'], value: 'new' }]
        }, { transaction: true })

        expect(client.$transaction).toHaveBeenCalled()
    })
})
