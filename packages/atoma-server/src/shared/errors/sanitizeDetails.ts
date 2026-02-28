import type { AtomaErrorDetails } from './core'
import { byteLengthUtf8 } from './core'

export function sanitizeDetails(details: unknown): AtomaErrorDetails | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined

    const kind = (details as any).kind
    if (
        kind !== 'validation'
        && kind !== 'auth'
        && kind !== 'limits'
        && kind !== 'conflict'
        && kind !== 'not_found'
        && kind !== 'adapter'
        && kind !== 'internal'
    ) {
        return undefined
    }

    const maxBytes = 8 * 1024
    const maxDepth = 8
    const maxString = 1024
    const seen = new WeakSet<object>()

    const clean = (value: any, depth: number): any => {
        if (value === null) return null

        const type = typeof value
        if (type === 'string') return value.length > maxString ? value.slice(0, maxString) : value
        if (type === 'number' || type === 'boolean') return value
        if (type === 'undefined') return undefined
        if (type === 'function' || type === 'symbol' || type === 'bigint') return undefined
        if (value instanceof Error) return undefined
        if (depth >= maxDepth) return undefined

        if (Array.isArray(value)) {
            const arr: any[] = []
            for (const item of value) {
                const normalized = clean(item, depth + 1)
                if (normalized !== undefined) arr.push(normalized)
            }
            return arr
        }

        if (value && typeof value === 'object') {
            if (seen.has(value)) return undefined
            seen.add(value)

            const out: Record<string, any> = {}
            for (const [key, entry] of Object.entries(value)) {
                if (!key) continue
                const normalized = clean(entry, depth + 1)
                if (normalized !== undefined) out[key] = normalized
            }
            return out
        }

        return undefined
    }

    const normalized = clean(details, 0) as any
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return undefined

    try {
        const json = JSON.stringify(normalized)
        if (byteLengthUtf8(json) > maxBytes) {
            return { kind, truncated: true } as AtomaErrorDetails
        }
        return normalized as AtomaErrorDetails
    } catch {
        return undefined
    }
}
