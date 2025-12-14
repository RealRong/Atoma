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

export const levenshteinDistance = (a: string, b: string, maxDistance?: number): number => {
    if (a === b) return 0

    let left = a
    let right = b
    let m = left.length
    let n = right.length

    if (m === 0) {
        if (maxDistance !== undefined) return n > maxDistance ? maxDistance + 1 : n
        return n
    }
    if (n === 0) {
        if (maxDistance !== undefined) return m > maxDistance ? maxDistance + 1 : m
        return m
    }

    if (m > n) {
        ;[left, right] = [right, left]
        ;[m, n] = [n, m]
    }

    let prev = new Uint32Array(n + 1)
    let curr = new Uint32Array(n + 1)

    if (maxDistance === undefined) {
        for (let j = 0; j <= n; j++) prev[j] = j
        for (let i = 1; i <= m; i++) {
            curr[0] = i
            const leftChar = left.charCodeAt(i - 1)
            for (let j = 1; j <= n; j++) {
                const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1
                const del = prev[j] + 1
                const ins = curr[j - 1] + 1
                const sub = prev[j - 1] + cost
                curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
            }
            const tmp = prev
            prev = curr
            curr = tmp
        }
        return prev[n]
    }

    const limit = maxDistance
    const big = limit + 1
    const offset = n - m
    if (offset > limit) return big

    prev.fill(big)
    const initMax = Math.min(n, offset + limit)
    for (let j = 0; j <= initMax; j++) prev[j] = j

    for (let i = 1; i <= m; i++) {
        const center = i + offset
        const minJ = Math.max(1, center - limit)
        const maxJ = Math.min(n, center + limit)

        curr[0] = i
        if (minJ > 1) curr[minJ - 1] = big
        if (maxJ < n) curr[maxJ + 1] = big

        let rowMin = big
        const leftChar = left.charCodeAt(i - 1)
        for (let j = minJ; j <= maxJ; j++) {
            const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1
            const del = prev[j] + 1
            const ins = curr[j - 1] + 1
            const sub = prev[j - 1] + cost
            const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
            curr[j] = v
            if (v < rowMin) rowMin = v
        }

        if (rowMin > limit) return big
        const tmp = prev
        prev = curr
        curr = tmp
    }

    const result = prev[n]
    return result > limit ? big : result
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
