import type { IndexDefinition } from 'atoma-types/core'
import type { CandidateResult, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { defaultTokenizer } from '../internal/tokenize'
import type { IndexCondition, IndexDriver } from '../types'
import { intersectAll, levenshteinDistance } from '../internal/search'
import { validateString } from '../internal/value'

export class TextIndex<T> implements IndexDriver<T> {
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

    queryCandidates(condition: IndexCondition): CandidateResult {
        switch (condition.op) {
            case 'match':
                return this.queryTokens(condition.value.q, 0)
            case 'fuzzy':
                return this.queryTokens(
                    condition.value.q,
                    condition.value.distance ?? this.fuzzyDistance
                )
            default:
                return { kind: 'unsupported' }
        }
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

    private queryTokens(query: string, distance: 0 | 1 | 2): CandidateResult {
        const tokens = this.tokenize(query)
        if (!tokens.length) return { kind: 'empty' }

        const tokenSets: Set<EntityId>[] = []
        for (const token of tokens) {
            const ids = this.lookupToken(token, distance)
            if (ids.size === 0) return { kind: 'empty' }
            tokenSets.push(ids)
        }

        const ids = intersectAll(tokenSets)
        if (ids.size === 0) return { kind: 'empty' }
        return { kind: 'candidates', ids, exactness: distance ? 'superset' : 'exact' }
    }

    private lookupToken(token: string, distance: 0 | 1 | 2): Set<EntityId> {
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

    private tokenize(input: string): string[] {
        return this.tokenizer(input.toLowerCase()).filter(token => token.length >= this.minTokenLength)
    }
}
