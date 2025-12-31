import { describe, expect, it } from 'vitest'
import { Core } from '../../src/core'

describe('applyQuery', () => {
    it('where=function 时会正确过滤', () => {
        const data = [
            { id: 1, title: 'a' },
            { id: 2, title: 'b' }
        ]

        const out = Core.query.applyQuery(data as any, { where: (item: any) => item.id === 2 } as any)

        expect(out.map(i => i.id)).toEqual([2])
    })
})

