import { describe, it, expect } from 'vitest'
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
            orderBy: { field: 'createdAt', direction: 'desc' },
            limit: 5,
            offset: 10,
            select: { id: true, title: true }
        })

        expect(res.pageInfo?.total).toBe(2)
        expect(qb.conditions.length).toBeGreaterThanOrEqual(2)
        expect(qb.orders[0]).toMatchObject({ column: 'comment.createdAt', direction: 'DESC' })
        expect(qb.takeValue).toBe(5)
        expect(qb.skipValue).toBe(10)
        expect(qb.selected).toContain('comment.id')
        expect(qb.selected).toContain('comment.title')
    })

    it('cursor 默认为 id 大于给定值的过滤', async () => {
        const qb = new FakeQueryBuilder()
        const ds = createDataSource(qb)
        const adapter = new AtomaTypeormAdapter(ds)

        await adapter.findMany('comment', { cursor: 100 })

        expect(qb.conditions.some(c => c.sql.includes('.id > :cursor'))).toBe(true)
    })
})
