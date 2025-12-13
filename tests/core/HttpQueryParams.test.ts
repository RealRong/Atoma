import { describe, it, expect } from 'vitest'
import { buildQueryParams } from '../../src/adapters/http/query'

describe('buildQueryParams（Atoma server REST 协议）', () => {
    it('where 使用 where.<field>，cursor 映射为 after', () => {
        const params = buildQueryParams({
            fields: ['id', 'title'] as any,
            where: { postId: 1, published: true },
            limit: 20,
            offset: 0,
            cursor: 'tok',
            orderBy: { field: 'createdAt' as any, direction: 'desc' }
        })

        const s = params.toString()
        expect(s).toContain('fields=id%2Ctitle')
        expect(s).toContain('where%5BpostId%5D=1')
        expect(s).toContain('where%5Bpublished%5D=true')
        expect(s).toContain('limit=20')
        expect(s).toContain('offset=0')
        expect(s).toContain('after=tok')
        expect(s).toContain('orderBy=createdAt%3Adesc')
        expect(s).not.toContain('cursor=')
    })
})
