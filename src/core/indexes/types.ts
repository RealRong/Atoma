export type IndexStats = {
    totalDocs: number
    distinctValues: number
    avgSetSize: number
    maxSetSize: number
    minSetSize: number
    totalTokens?: number
    avgDocTokens?: number
}
