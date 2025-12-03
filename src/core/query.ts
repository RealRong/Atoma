import { FindManyOptions } from './types'

type WhereValue =
    | any
    | {
        in?: any[]
        gt?: number
        gte?: number
        lt?: number
        lte?: number
        startsWith?: string
        endsWith?: string
        contains?: string
    }

const normalizeString = (value: any) => {
    if (value === undefined || value === null) return ''
    return String(value).toLowerCase()
}

const matchesCondition = (value: any, condition: WhereValue): boolean => {
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        const { in: inArr, gt, gte, lt, lte, contains, startsWith, endsWith } = condition as any
        if (inArr && Array.isArray(inArr)) {
            if (!inArr.some(v => v === value)) return false
        }
        if (gt !== undefined && !(value > gt)) return false
        if (gte !== undefined && !(value >= gte)) return false
        if (lt !== undefined && !(value < lt)) return false
        if (lte !== undefined && !(value <= lte)) return false
        const haystack = normalizeString(value)
        if (startsWith !== undefined) {
            if (!haystack.startsWith(normalizeString(startsWith))) return false
        }
        if (endsWith !== undefined) {
            if (!haystack.endsWith(normalizeString(endsWith))) return false
        }
        if (contains !== undefined) {
            const needle = normalizeString(contains)
            if (!haystack.includes(needle)) return false
        }
        return true
    }
    return value === condition
}

/**
 * Create a comparison function from OrderBy rules
 */
function compareBy<T>(rules: Array<{ field: string, direction: 'asc' | 'desc' }>): (a: T, b: T) => number {
    return (a, b) => {
        for (const rule of rules) {
            const { field, direction } = rule
            const av = (a as any)[field]
            const bv = (b as any)[field]
            if (av === bv) continue
            if (av === undefined || av === null) return 1
            if (bv === undefined || bv === null) return -1
            if (av > bv) return direction === 'desc' ? -1 : 1
            if (av < bv) return direction === 'desc' ? 1 : -1
        }
        return 0
    }
}

/**
 * Quick select algorithm for finding top-k elements
 * Average O(n), worst case O(n²)
 */
function quickSelect<T>(arr: T[], compareFn: (a: T, b: T) => number, k: number): T[] {
    if (k >= arr.length) {
        return arr.slice().sort(compareFn)
    }

    // 使用快速选择找到第 k 小的元素的位置
    const partition = (left: number, right: number, pivotIndex: number): number => {
        const pivotValue = arr[pivotIndex]
            // 将 pivot 移到末尾
            ;[arr[pivotIndex], arr[right]] = [arr[right], arr[pivotIndex]]
        let storeIndex = left
        for (let i = left; i < right; i++) {
            if (compareFn(arr[i], pivotValue) < 0) {
                ;[arr[i], arr[storeIndex]] = [arr[storeIndex], arr[i]]
                storeIndex++
            }
        }
        // 将 pivot 移到最终位置
        ;[arr[storeIndex], arr[right]] = [arr[right], arr[storeIndex]]
        return storeIndex
    }

    let left = 0
    let right = arr.length - 1

    while (left < right) {
        // 随机选择 pivot 避免最坏情况
        const pivotIndex = left + Math.floor(Math.random() * (right - left + 1))
        const pivotNewIndex = partition(left, right, pivotIndex)

        if (pivotNewIndex === k - 1) {
            break
        } else if (pivotNewIndex < k - 1) {
            left = pivotNewIndex + 1
        } else {
            right = pivotNewIndex - 1
        }
    }

    // 返回前 k 个元素并排序
    return arr.slice(0, k).sort(compareFn)
}

export function applyQuery<T extends Record<string, any>>(data: T[], options?: FindManyOptions<T>, opts?: { preSorted?: boolean }): T[] {
    if (!options) return data
    const { where, orderBy, limit, offset } = options

    let result = data

    // 1. Apply where filter
    if (where && Object.keys(where).length > 0) {
        result = result.filter(item => {
            return Object.entries(where).every(([field, cond]) => {
                return matchesCondition((item as any)[field], cond as WhereValue)
            })
        })
    }

    // 2. Apply sorting with Top-K optimization
    if (orderBy && !opts?.preSorted) {
        const rules = Array.isArray(orderBy) ? orderBy : [orderBy]
        const compareFn = compareBy(rules)

        if (limit !== undefined) {
            const k = (offset ?? 0) + limit

            // 🔥 Top-K optimization: use quickSelect when k < 10% of data
            if (k < result.length * 0.1 && k < result.length) {
                // Make a copy for in-place quickSelect
                const copy = result.slice()
                result = quickSelect(copy, compareFn, k)
            } else {
                // Full sort for large k or small datasets
                result = result.slice().sort(compareFn)
            }
        } else {
            // No limit, need full sort
            result = result.slice().sort(compareFn)
        }
    }

    // 3. Apply offset and limit
    const start = offset ?? 0
    const end = limit !== undefined ? start + limit : undefined
    return end !== undefined ? result.slice(start, end) : result.slice(start)
}

export function extractQueryFields<T>(options?: FindManyOptions<T>): string[] {
    if (!options) return []
    const fields = new Set<string>()
    if (options.where) {
        Object.keys(options.where as any).forEach(k => fields.add(k))
    }
    if (options.orderBy) {
        const rules = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
        rules.forEach(rule => fields.add((rule as any).field))
    }
    return Array.from(fields)
}

export const stableStringify = (obj: any): string => {
    const seen = new WeakSet()
    const helper = (value: any): any => {
        if (value === null || typeof value !== 'object') return value
        if (seen.has(value)) return undefined
        seen.add(value)
        if (Array.isArray(value)) return value.map(v => helper(v))
        const entries = Object.entries(value as Record<string, any>).sort(([a], [b]) => a.localeCompare(b))
        const normalized: Record<string, any> = {}
        entries.forEach(([k, v]) => {
            if (typeof v === 'function') return
            normalized[k] = helper(v)
        })
        return normalized
    }
    try {
        return JSON.stringify(helper(obj))
    } catch {
        return ''
    }
}
