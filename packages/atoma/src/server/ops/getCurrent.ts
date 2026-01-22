import type { IOrmAdapter } from '../adapters/ports'

export function createGetCurrent(adapter: IOrmAdapter, resource: string) {
    return (id: any) => {
        const cache = new Map<string, unknown | undefined>()
        return async (fields: string[]) => {
            const normalized = Array.isArray(fields) ? fields.filter(f => typeof f === 'string' && f) : []
            const key = normalized.slice().sort().join(',')
            if (!key) return undefined
            if (cache.has(key)) return cache.get(key)

            const res = await adapter.findMany(resource, { where: { id }, fields: normalized })
            const cur = Array.isArray(res?.data) ? res.data[0] : undefined
            cache.set(key, cur)
            return cur
        }
    }
}
