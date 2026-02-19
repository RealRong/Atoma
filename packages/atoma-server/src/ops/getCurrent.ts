import type { IOrmAdapter } from '../adapters/ports'

export function createGetCurrent(adapter: IOrmAdapter, resource: string) {
    return (id: any) => {
        const cache = new Map<string, unknown | undefined>()
        return async (fields: string[]) => {
            const normalized = Array.isArray(fields) ? fields.filter(f => typeof f === 'string' && f) : []
            const key = normalized.slice().sort().join(',')
            if (!key) return undefined
            if (cache.has(key)) return cache.get(key)

            const FULL_KEY = '__full__'
            if (!cache.has(FULL_KEY)) {
                const res = await adapter.findMany(resource, {
                    filter: { op: 'eq', field: 'id', value: id },
                    page: { mode: 'offset', limit: 1 }
                })
                const cur = Array.isArray(res?.data) ? res.data[0] : undefined
                cache.set(FULL_KEY, cur)
            }

            const current = cache.get(FULL_KEY)
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                cache.set(key, undefined)
                return undefined
            }

            const projected: Record<string, unknown> = {}
            normalized.forEach((field) => {
                projected[field] = (current as Record<string, unknown>)[field]
            })
            cache.set(key, projected)
            return projected
        }
    }
}
