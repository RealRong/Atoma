import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import type { DataSource, SelectQueryBuilder } from 'typeorm'
import { AtomaTypeormAdapter } from '../../src/server/typeorm'

class FakeQueryBuilder implements Partial<SelectQueryBuilder<any>> {
    conditions: Array<{ sql: string, params?: any }> = []
    orders: Array<{ column: string, direction: string }> = []
    skipValue?: number
    takeValue?: number
    selected?: string[]

    constructor(private readonly data: any[] = [{ id: 1 }], private readonly total = 1) {}

    andWhere(sql: string, params?: any) {
        this.conditions.push({ sql, params })
        return this
    }

    orderBy(column: string, direction?: any) {
        this.orders.push({ column, direction })
        return this
    }

    addOrderBy(column: string, direction?: any) {
        this.orders.push({ column, direction })
        return this
    }

    skip(v: number) {
        this.skipValue = v
        return this
    }

    take(v: number) {
        this.takeValue = v
        return this
    }

    select(fields?: string[]) {
        this.selected = fields
        return this
    }

    async getMany() {
        return this.data
    }

    async getManyAndCount() {
        return [this.data, this.total]
    }
}

const createDataSource = (qb: FakeQueryBuilder): DataSource => {
    const repo = {
        createQueryBuilder: () => qb
    }

    return {
        getRepository: () => repo,
        getMetadata: () => ({})
    } as unknown as DataSource
}

describe('AtomaTypeormAdapter', () => {
    it('转换 where/orderBy/limit/offset 到 QueryBuilder', async () => {
        const qb = new FakeQueryBuilder([{ id: 1 }, { id: 2 }], 2)
        const ds = createDataSource(qb)
        const adapter = new AtomaTypeormAdapter(ds)

        const res = await adapter.findMany('comment', {
            where: { postId: { in: [1, 2] }, score: { gt: 10 }, title: { contains: 'abc' } },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            page: { mode: 'offset', limit: 5, offset: 10, includeTotal: true },
            select: { id: true, title: true }
        })

        expect(res.pageInfo?.total).toBe(2)
        expect(qb.conditions.length).toBeGreaterThanOrEqual(2)
        expect(qb.orders[0]).toMatchObject({ column: 'comment.createdAt', direction: 'DESC' })
        // 稳定排序：追加 id asc
        expect(qb.orders[1]).toMatchObject({ column: 'comment.id', direction: 'ASC' })
        expect(qb.takeValue).toBe(5)
        expect(qb.skipValue).toBe(10)
        expect(qb.selected).toContain('comment.id')
        expect(qb.selected).toContain('comment.title')
    })

    it('cursor keyset 会生成基于 orderBy 的过滤（默认按 id asc）', async () => {
        const qb = new FakeQueryBuilder()
        const ds = createDataSource(qb)
        const adapter = new AtomaTypeormAdapter(ds)

        // token: [id]
        const after = Buffer.from(JSON.stringify({ v: [100] }), 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
        await adapter.findMany('comment', { page: { mode: 'cursor', limit: 10, after } })

        expect(qb.conditions.some(c => c.sql.includes('.id > :'))).toBe(true)
    })

    it('bulkCreate 非事务模式下返回 partialFailures', async () => {
        const repo = {
            save: vi.fn(async (item: any) => {
                if (item.fail) throw new Error('boom')
                return item
            })
        }
        const ds = {
            getRepository: () => repo,
            getMetadata: () => ({})
        } as unknown as DataSource

        const adapter = new AtomaTypeormAdapter(ds)
        const res = await adapter.bulkCreate('post', [{ id: 1 }, { id: 2, fail: true }, { id: 3 }])

        expect(repo.save).toHaveBeenCalledTimes(3)
        expect(res.data).toHaveLength(2)
        expect(res.partialFailures?.[0]).toMatchObject({ index: 1 })
    })

    it('patch 会应用 immer patches 并保存', async () => {
        class Post {
            constructor(public id: number, public title: string, public body: string) {}
        }
        const repo: any = {
            findOne: vi.fn(async ({ where }: any) => new Post(where.id, 'old', 'b')),
            save: vi.fn(async (entity: any) => entity),
            metadata: { columns: [{ propertyName: 'id' }, { propertyName: 'title' }, { propertyName: 'body' }] }
        }
        const ds = {
            getRepository: () => repo,
            getMetadata: () => ({})
        } as unknown as DataSource

        const adapter = new AtomaTypeormAdapter(ds)
        const res = await adapter.patch('post', {
            id: 1,
            patches: [
                { op: 'replace', path: [1, 'title'], value: 'new' },
                { op: 'replace', path: [1, 'body'], value: 'bb' }
            ]
        })

        expect(repo.findOne).toHaveBeenCalled()
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ title: 'new' }))
        expect(res.data).toMatchObject({ id: 1, title: 'new', body: 'bb' })
    })

    it('bulkPatch 记录 partialFailures', async () => {
        const repo: any = {
            findOne: vi.fn(async ({ where }: any) => where.id === 1 ? { id: 1, title: 't1' } : undefined),
            save: vi.fn(async (entity: any) => entity),
            metadata: { columns: [{ propertyName: 'id' }, { propertyName: 'title' }] }
        }
        const ds = {
            getRepository: () => repo,
            getMetadata: () => ({})
        } as unknown as DataSource

        const adapter = new AtomaTypeormAdapter(ds)
        const res = await adapter.bulkPatch('post', [
            { id: 1, patches: [{ op: 'replace', path: [1, 'title'], value: 'new' }] },
            { id: 2, patches: [{ op: 'replace', path: [2, 'title'], value: 'x' }] }
        ])

        expect(repo.save).toHaveBeenCalledTimes(1)
        expect(res.data).toHaveLength(1)
        expect(res.partialFailures?.[0]?.index).toBe(1)
    })
})
