export function stableStringify(obj: any): string {
    const seen = new WeakSet<object>()

    const helper = (value: any): any => {
        if (value === null || typeof value !== 'object') return value
        if (seen.has(value)) return undefined
        seen.add(value)

        if (Array.isArray(value)) return value.map(v => helper(v))

        const entries = Object.entries(value as Record<string, any>)
            .sort(([a], [b]) => a.localeCompare(b))

        const normalized: Record<string, any> = {}
        for (const [k, v] of entries) {
            if (typeof v === 'function') continue
            normalized[k] = helper(v)
        }
        return normalized
    }

    try {
        const s = JSON.stringify(helper(obj))
        return typeof s === 'string' ? s : ''
    } catch {
        return ''
    }
}

