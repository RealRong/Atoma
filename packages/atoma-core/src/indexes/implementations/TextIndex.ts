import type { IndexDefinition } from 'atoma-types/core'
import type { CandidateResult, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { defaultTokenizer } from '../tokenizer'
import { IIndex } from '../base/IIndex'
import { intersectAll, levenshteinDistance } from '../utils'
import { validateString } from '../validators'

type TokenOperator = 'and' | 'or'

type MatchSpec = {
    q?: unknown
    op?: TokenOperator
    minTokenLength?: number
    tokenizer?: (text: string) => string[]
}

type FuzzySpec = MatchSpec & {
    distance?: 0 | 1 | 2
}

type TextCondition = {
    match?: string | MatchSpec
    fuzzy?: string | FuzzySpec
}

export class TextIndex<T> implements IIndex<T> {
    readonly type = 'text'
    readonly config: IndexDefinition<T>

    private invertedIndex = new Map<string, Set<EntityId>>()
    private docTokens = new Map<EntityId, string[]>()

    private tokenizer: (text: string) => string[]
    private minTokenLength: number
    private fuzzyDistance: 0 | 1 | 2

    constructor(config: IndexDefinition<T>) {
        this.config = config
        this.tokenizer = config.options?.tokenizer || defaultTokenizer
        this.minTokenLength = config.options?.minTokenLength ?? 3
        this.fuzzyDistance = config.options?.fuzzyDistance ?? 1
    }

    add(id: EntityId, value: unknown): void {
        const text = validateString(value, this.config.field, id)
        const tokens = this.tokenize(text)
        this.docTokens.set(id, tokens)
        tokens.forEach(token => {
            if (token.length < this.minTokenLength) return
            let set = this.invertedIndex.get(token)
            if (!set) {
                set = new Set<EntityId>()
                this.invertedIndex.set(token, set)
            }
            set.add(id)
        })
    }

    remove(id: EntityId, value: unknown): void {
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
    }

    clear(): void {
        this.invertedIndex.clear()
        this.docTokens.clear()
    }

    queryCandidates(condition: unknown): CandidateResult {
        if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
            return { kind: 'unsupported' }
        }

        const parsed = condition as TextCondition
        if (parsed.match === undefined && parsed.fuzzy === undefined) {
            return { kind: 'unsupported' }
        }

        const spec = parsed.match !== undefined ? parsed.match : parsed.fuzzy
        const isFuzzy = parsed.fuzzy !== undefined
        const resolved = typeof spec === 'string' ? { q: spec } : (spec || {})
        const query = String(resolved.q ?? '')
        const operator = resolved.op || 'and'
        const distance: 0 | 1 | 2 = isFuzzy
            ? ((resolved as FuzzySpec).distance ?? this.fuzzyDistance)
            : 0
        const minTokenLength = resolved.minTokenLength ?? this.minTokenLength
        const tokenizer = resolved.tokenizer || this.tokenizer || defaultTokenizer

        const tokens = tokenizer(query)
            .filter((token: string) => token.length >= minTokenLength)
            .map((token: string) => token.toLowerCase())
        if (!tokens.length) return { kind: 'empty' }

        const tokenSets: Set<EntityId>[] = []
        const tokenUnions: Set<EntityId>[] = []

        const lookupToken = (token: string): Set<EntityId> => {
            const exact = this.invertedIndex.get(token)
            if (exact) return new Set(exact)
            if (!distance) return new Set()
            const fuzzyMatches = new Set<EntityId>()
            this.invertedIndex.forEach((set, indexedToken) => {
                if (Math.abs(indexedToken.length - token.length) > distance) return
                if (levenshteinDistance(token, indexedToken, distance) <= distance) {
                    set.forEach(id => fuzzyMatches.add(id))
                }
            })
            return fuzzyMatches
        }

        tokens.forEach((token: string) => {
            const ids = lookupToken(token)
            if (operator === 'and') {
                tokenSets.push(ids)
            } else {
                tokenUnions.push(ids)
            }
        })

        if (operator === 'and') {
            if (tokenSets.some(set => set.size === 0)) return { kind: 'empty' }
            const ids = intersectAll(tokenSets)
            if (ids.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids, exactness: distance ? 'superset' : 'exact' }
        }

        const union = new Set<EntityId>()
        tokenUnions.forEach(set => set.forEach(id => union.add(id)))
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
        return false
    }

    private tokenize(input: string): string[] {
        return this.tokenizer(input.toLowerCase()).filter(token => token.length >= this.minTokenLength)
    }
}
