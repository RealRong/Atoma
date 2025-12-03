export const binarySearchLeft = (entries: Array<{ value: number }>, target: number) => {
    let left = 0
    let right = entries.length
    while (left < right) {
        const mid = (left + right) >> 1
        if (entries[mid].value < target) {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return left
}

export const binarySearchRight = (entries: Array<{ value: number }>, target: number) => {
    let left = 0
    let right = entries.length
    while (left < right) {
        const mid = (left + right) >> 1
        if (entries[mid].value <= target) {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return left
}

export const binarySearchPrefix = (tokens: string[], prefix: string): { start: number; end: number } => {
    const n = tokens.length
    if (n === 0 || prefix.length === 0) return { start: 0, end: 0 }

    let left = 0
    let right = n
    while (left < right) {
        const mid = (left + right) >> 1
        if (tokens[mid] < prefix) {
            left = mid + 1
        } else {
            right = mid
        }
    }
    const start = left

    const upperBound = prefix + '\uffff'
    left = start
    right = n
    while (left < right) {
        const mid = (left + right) >> 1
        if (tokens[mid] < upperBound) {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return { start, end: left }
}

export const levenshteinDistance = (a: string, b: string): number => {
    if (a === b) return 0
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            )
        }
    }
    return dp[m][n]
}

export const intersectAll = <T>(sets: Set<T>[]): Set<T> => {
    if (sets.length === 0) return new Set()
    sets.sort((a, b) => a.size - b.size)
    let acc = new Set<T>(sets[0])
    for (let i = 1; i < sets.length; i++) {
        const next = sets[i]
        const merged = new Set<T>()
        const iterate = acc.size <= next.size ? acc : next
        const other = acc.size <= next.size ? next : acc
        iterate.forEach(id => {
            if (other.has(id)) merged.add(id)
        })
        acc = merged
        if (acc.size === 0) break
    }
    return acc
}
