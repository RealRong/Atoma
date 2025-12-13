import { IndexDefinition, StoreKey } from '../../types'
import { CandidateResult, IndexStats } from '../types'
import { binarySearchPrefix, intersectAll, levenshteinDistance } from '../utils'
import { defaultTokenizer } from '../tokenizer'
import { validateString } from '../validators'
import { IIndex } from '../base/IIndex'

export class TextIndex<T> implements IIndex<T> {
    readonly type = 'text'
    readonly config: IndexDefinition<T>

    private invertedIndex = new Map<string, Set<StoreKey>>()
    private docTokens = new Map<StoreKey, string[]>()
    private sortedTokens: string[] | null = null
    private dirty = false

    private tokenizer: (text: string) => string[]
    private minTokenLength: number
    private fuzzyDistance: 0 | 1 | 2

    constructor(config: IndexDefinition<T>) {
        if (config.type !== 'text') {
            throw new Error(`[Atoma Index] Invalid type "${config.type}" for TextIndex.`)
        }
        this.config = config
        this.tokenizer = config.options?.tokenizer || defaultTokenizer
        this.minTokenLength = config.options?.minTokenLength ?? 3
        this.fuzzyDistance = config.options?.fuzzyDistance ?? 1
    }

    add(id: StoreKey, value: any): void {
        const text = validateString(value, this.config.field, id)
        const tokens = this.tokenize(text)
        this.docTokens.set(id, tokens)
        tokens.forEach(token => {
            if (token.length < this.minTokenLength) return
            let set = this.invertedIndex.get(token)
            if (!set) {
                set = new Set<StoreKey>()
                this.invertedIndex.set(token, set)
            }
            set.add(id)
        })
        this.sortedTokens = null
        this.dirty = true
    }

    remove(id: StoreKey, value: any): void {
        const tokens = this.docTokens.get(id) || this.tokenize(validateString(value, this.config.field, id))
        tokens.forEach(token => {
            const set = this.invertedIndex.get(token)
            if (set) {
                set.delete(id)
                if (set.size === 0) {
                    this.invertedIndex.delete(token)
                }
            }
        })
        this.docTokens.delete(id)
        this.sortedTokens = null
        this.dirty = true
    }

    clear(): void {
        this.invertedIndex.clear()
        this.docTokens.clear()
        this.sortedTokens = null
        this.dirty = true
    }

    queryCandidates(_condition: any): CandidateResult {
        const condition = _condition
        if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
            return { kind: 'unsupported' }
        }

        const matchSpec = (condition as any).match
        const fuzzySpec = (condition as any).fuzzy
        if (matchSpec === undefined && fuzzySpec === undefined) return { kind: 'unsupported' }

        const spec = matchSpec !== undefined ? matchSpec : fuzzySpec
        const isFuzzy = fuzzySpec !== undefined
        const resolved = typeof spec === 'string' ? { q: spec } : spec
        const query = String((resolved as any).q ?? '')
        const op = ((resolved as any).op as 'and' | 'or' | undefined) || 'and'
        const distance: 0 | 1 | 2 = isFuzzy ? (((resolved as any).distance ?? this.fuzzyDistance) as any) : 0
        const minTokenLength = (resolved as any).minTokenLength ?? this.minTokenLength
        const tokenizer: (text: string) => string[] = (resolved as any).tokenizer || this.tokenizer || defaultTokenizer

        const tokens = tokenizer(query)
            .filter((t: string) => t.length >= minTokenLength)
            .map((t: string) => t.toLowerCase())
        if (!tokens.length) return { kind: 'empty' }

        const tokenSets: Set<StoreKey>[] = []
        const tokenUnions: Set<StoreKey>[] = []

        const lookupToken = (token: string): Set<StoreKey> => {
            const exact = this.invertedIndex.get(token)
            if (exact) return new Set(exact)
            if (!distance) return new Set()
            const fuzzyMatches = new Set<StoreKey>()
            this.invertedIndex.forEach((set, t) => {
                if (Math.abs(t.length - token.length) > distance) return
                if (levenshteinDistance(token, t) <= distance) {
                    set.forEach(id => fuzzyMatches.add(id))
                }
            })
            return fuzzyMatches
        }

        tokens.forEach((token: string) => {
            const ids = lookupToken(token)
            if (op === 'and') {
                tokenSets.push(ids)
            } else {
                tokenUnions.push(ids)
            }
        })

        if (op === 'and') {
            if (tokenSets.some(s => s.size === 0)) return { kind: 'empty' }
            const ids = intersectAll(tokenSets)
            if (ids.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids, exactness: distance ? 'superset' : 'exact' }
        }

        const union = new Set<StoreKey>()
        tokenUnions.forEach(s => s.forEach(id => union.add(id)))
        if (union.size === 0) return { kind: 'empty' }
        return { kind: 'candidates', ids: union, exactness: distance ? 'superset' : 'exact' }
    }

    getStats(): IndexStats {
        const docCount = this.docTokens.size
        let totalTokenRefs = 0
        let maxSetSize = 0
        let minSetSize = Number.POSITIVE_INFINITY
        this.invertedIndex.forEach(set => {
            const size = set.size
            totalTokenRefs += size
            if (size > maxSetSize) maxSetSize = size
            if (size < minSetSize) minSetSize = size
        })
        let totalTokens = 0
        this.docTokens.forEach(tokens => {
            totalTokens += tokens.length
        })
        const distinctValues = this.invertedIndex.size
        return {
            totalDocs: docCount,
            distinctValues,
            avgSetSize: distinctValues ? totalTokenRefs / distinctValues : 0,
            maxSetSize: distinctValues ? maxSetSize : 0,
            minSetSize: distinctValues ? minSetSize : 0,
            totalTokens,
            avgDocTokens: docCount ? totalTokens / docCount : 0
        }
    }

    isDirty(): boolean {
        return this.dirty
    }

    private tokenize(input: string): string[] {
        return this.tokenizer(input.toLowerCase()).filter(t => t.length >= this.minTokenLength)
    }

    private buildSortedTokens(): string[] {
        if (!this.sortedTokens || this.dirty) {
            this.sortedTokens = Array.from(this.invertedIndex.keys()).sort()
            this.dirty = false
        }
        return this.sortedTokens
    }

    private prefixSearch(prefix: string): Set<StoreKey> {
        const normalized = prefix.toLowerCase()
        if (normalized.length < this.minTokenLength) return new Set()
        const sorted = this.buildSortedTokens()
        const { start, end } = binarySearchPrefix(sorted, normalized)
        const results = new Set<StoreKey>()
        for (let i = start; i < end; i++) {
            const token = sorted[i]
            if (!token.startsWith(normalized)) break
            const ids = this.invertedIndex.get(token)
            if (ids) ids.forEach(id => results.add(id))
        }
        return results
    }

    /**
     * 后缀搜索（无索引优化，O(N)）
     */
    private suffixSearch(suffix: string): Set<StoreKey> {
        const normalized = suffix.toLowerCase()
        if (normalized.length < this.minTokenLength) return new Set()
        const results = new Set<StoreKey>()
        this.invertedIndex.forEach((set, token) => {
            if (token.length < normalized.length) return
            if (token.endsWith(normalized)) {
                set.forEach(id => results.add(id))
            }
        })
        return results
    }

    private exactSearch(query: string): Set<StoreKey> | undefined {
        const tokens = this.tokenize(query)
        if (!tokens.length) return new Set()
        const sets: Set<StoreKey>[] = []
        tokens.forEach(token => {
            const ids = this.invertedIndex.get(token)
            if (ids) sets.push(new Set(ids))
        })
        return sets.length ? intersectAll(sets) : new Set()
    }

    private fulltextSearch(query: string): Set<StoreKey> | undefined {
        const tokens = this.tokenize(query)
        if (!tokens.length) return new Set()
        const tokenSets: Set<StoreKey>[] = []
        tokens.forEach(token => {
            const exact = this.invertedIndex.get(token)
            if (exact) {
                tokenSets.push(new Set(exact))
                return
            }
            if (this.fuzzyDistance > 0) {
                const fuzzyMatches = new Set<StoreKey>()
                this.invertedIndex.forEach((set, t) => {
                    if (Math.abs(t.length - token.length) > this.fuzzyDistance) return
                    if (levenshteinDistance(token, t) <= this.fuzzyDistance) {
                        set.forEach(id => fuzzyMatches.add(id))
                    }
                })
                if (fuzzyMatches.size) tokenSets.push(fuzzyMatches)
            }
        })
        return tokenSets.length ? intersectAll(tokenSets) : new Set()
    }
}
