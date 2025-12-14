
import { describe, it, expect } from 'vitest'
import { levenshteinDistance } from '../../src/core/indexes/utils'

describe('levenshteinDistance', () => {
    it('returns exact distance when no maxDistance is provided', () => {
        expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
        expect(levenshteinDistance('book', 'back')).toBe(2)
        expect(levenshteinDistance('', 'abc')).toBe(3)
        expect(levenshteinDistance('abc', '')).toBe(3)
    })

    it('returns maxDistance + 1 when the true distance exceeds the limit', () => {
        expect(levenshteinDistance('kitten', 'sitting', 2)).toBe(3)
        expect(levenshteinDistance('a', 'aaaa', 2)).toBe(3)
        expect(levenshteinDistance('abc', 'ab', 0)).toBe(1)
    })

    it('returns the exact distance when the true distance is within the limit', () => {
        expect(levenshteinDistance('book', 'back', 2)).toBe(2)
        expect(levenshteinDistance('abc', 'abc', 0)).toBe(0)
        expect(levenshteinDistance('ab', 'abc', 1)).toBe(1)
    })
})

