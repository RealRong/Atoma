import type { SortRule } from 'atoma-types/core'

const readSortField = <T>(item: T, field: string): unknown => {
    return (item as Record<string, unknown>)[field]
}

export function isSameSortRules(left: SortRule[], right: SortRule[]): boolean {
    if (left.length !== right.length) return false

    for (let index = 0; index < left.length; index++) {
        const a = left[index]
        const b = right[index]
        if (a.field !== b.field || a.dir !== b.dir) return false
    }

    return true
}

export function compareBy<T>(rules: SortRule[]): (a: T, b: T) => number {
    return (a, b) => {
        for (const rule of rules) {
            const av = readSortField(a, rule.field)
            const bv = readSortField(b, rule.field)
            if (av === bv) continue
            if (av === undefined || av === null) return 1
            if (bv === undefined || bv === null) return -1
            if (av > bv) return rule.dir === 'desc' ? -1 : 1
            if (av < bv) return rule.dir === 'desc' ? 1 : -1
        }

        return 0
    }
}

export function compareItemToValues<T>(item: T, values: unknown[], rules: SortRule[]): number {
    for (let index = 0; index < rules.length; index++) {
        const rule = rules[index]
        const av = readSortField(item, rule.field)
        const bv = values[index]
        if (av === bv) continue
        if (av === undefined || av === null) return 1
        if (bv === undefined || bv === null) return -1
        if (av > bv) return rule.dir === 'desc' ? -1 : 1
        if (av < bv) return rule.dir === 'desc' ? 1 : -1
    }

    return 0
}

export function getSortValues<T>(item: T, rules: SortRule[]): unknown[] {
    return rules.map(rule => readSortField(item, rule.field))
}
