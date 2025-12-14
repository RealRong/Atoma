
import { describe, it, expect } from 'vitest'
import { fuzzySearch } from '../../src/core/search'

describe('fuzzySearch', () => {
    it('matches subsequence and returns highlights', () => {
        const items = [{ name: 'foobar' }, { name: 'baz' }]
        const res = fuzzySearch(items, 'fbr', { fields: ['name'] })
        expect(res.hits.length).toBe(1)
        expect(res.hits[0].item.name).toBe('foobar')
        expect(res.hits[0].highlights?.name).toEqual([{ start: 0, end: 1 }, { start: 3, end: 4 }, { start: 5, end: 6 }])
    })

    it('ranks more contiguous matches higher', () => {
        const items = [{ name: 'foobar' }, { name: 'fbar' }]
        const res = fuzzySearch(items, 'fbar', { fields: ['name'] })
        expect(res.hits[0].item.name).toBe('fbar')
    })

    it('supports multi-term queries (space separated)', () => {
        const items = [{ name: 'foo bar' }, { name: 'foo baz' }]
        const res = fuzzySearch(items, 'fo br', { fields: ['name'] })
        expect(res.hits.length).toBe(1)
        expect(res.hits[0].item.name).toBe('foo bar')
    })
})

