import { describe, it, expect } from 'vitest'
import { normalizeAtomaServerQueryParams } from '../../src/batch/queryParams'

describe('normalizeAtomaServerQueryParams（Batch 协议 QueryParams）', () => {
    it('将 limit/offset/includeTotal 转成 page（offset）并删除旧字段', () => {
        const out = normalizeAtomaServerQueryParams<any>({
            traceId: 't1' as any,
            fetchPolicy: 'remote' as any,
            include: { author: true } as any,
            where: { published: true } as any,
            orderBy: { field: 'createdAt', direction: 'desc' } as any,
            limit: 20,
            offset: 10,
            includeTotal: false
        })

        expect(out).toEqual({
            where: { published: true },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            page: { mode: 'offset', limit: 20, offset: 10, includeTotal: false }
        })
        expect(out).not.toHaveProperty('limit')
        expect(out).not.toHaveProperty('offset')
        expect(out).not.toHaveProperty('includeTotal')
        expect(out).not.toHaveProperty('traceId')
        expect(out).not.toHaveProperty('fetchPolicy')
        expect(out).not.toHaveProperty('include')
    })

    it('将 cursor 映射为 page.after（cursor 模式）并删除 cursor/after/before', () => {
        const out = normalizeAtomaServerQueryParams<any>({
            limit: 15,
            cursor: 'tok'
        })

        expect(out.page).toEqual({ mode: 'cursor', limit: 15, after: 'tok' })
        expect(out).not.toHaveProperty('cursor')
        expect(out).not.toHaveProperty('after')
        expect(out).not.toHaveProperty('before')
    })

    it('不会透传未知字段', () => {
        const out = normalizeAtomaServerQueryParams<any>({
            where: { id: 1 } as any,
            page: { mode: 'cursor', limit: 5, after: 'should_not_pass' } as any,
            select: { id: true } as any,
            weird: { a: 1 } as any,
            another: 'x' as any
        })

        expect(out).toEqual({
            where: { id: 1 },
            page: { mode: 'offset', limit: 50 }
        })
    })
})
