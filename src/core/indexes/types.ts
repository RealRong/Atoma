import type { StoreKey } from '../types'

export type IndexStats = {
    totalDocs: number
    distinctValues: number
    avgSetSize: number
    maxSetSize: number
    minSetSize: number
    totalTokens?: number
    avgDocTokens?: number
}

export type CandidateExactness = 'exact' | 'superset'

export type CandidateResult =
    | { kind: 'unsupported' }
    | { kind: 'empty' }
    | { kind: 'candidates'; ids: Set<StoreKey>; exactness: CandidateExactness }
