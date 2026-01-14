import type { WriteOptions } from '#protocol'

export function stableStringifyForKey(value: any): string {
    if (value === null || value === undefined) return String(value)
    if (typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringifyForKey).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringifyForKey((value as any)[k])}`).join(',')}}`
}

export function optionsKey(options: WriteOptions | undefined): string {
    if (!options) return ''
    return stableStringifyForKey(options)
}

