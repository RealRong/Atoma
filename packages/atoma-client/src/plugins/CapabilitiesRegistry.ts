import type { CapabilityKey, CapabilityToken } from 'atoma-types/client/registry'

const isCapabilityKey = (value: unknown): value is CapabilityKey<unknown> => {
    return typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string'
}

const getRawCapabilityKey = (key: CapabilityToken<unknown>): string => {
    return String(isCapabilityKey(key) ? key.key : key)
}

const normalizeCapabilityKeyForRegister = (key: CapabilityToken<unknown>): string => {
    const normalized = getRawCapabilityKey(key).trim()
    if (!normalized) {
        throw new Error('[Atoma] CapabilitiesRegistry.register: key 必填')
    }
    return normalized
}

const normalizeCapabilityKeyForGet = (key: CapabilityToken<unknown>): string | undefined => {
    const normalized = getRawCapabilityKey(key).trim()
    if (!normalized) return undefined
    return normalized
}

export class CapabilitiesRegistry {
    private readonly store = new Map<string, unknown>()

    register<T>(key: CapabilityKey<T>, value: T): () => void
    register(key: string, value: unknown): () => void
    register(key: CapabilityToken<unknown>, value: unknown): () => void {
        const normalizedKey = normalizeCapabilityKeyForRegister(key)
        this.store.set(normalizedKey, value)
        return () => {
            if (this.store.get(normalizedKey) === value) {
                this.store.delete(normalizedKey)
            }
        }
    }

    get<T>(key: CapabilityKey<T>): T | undefined
    get<T = unknown>(key: string): T | undefined
    get<T = unknown>(key: CapabilityToken<T>): T | undefined {
        const normalizedKey = normalizeCapabilityKeyForGet(key as CapabilityToken<unknown>)
        if (!normalizedKey) return undefined
        return this.store.get(normalizedKey) as T | undefined
    }

    list = (prefix?: string): Array<{ key: string; value: unknown }> => {
        const p = typeof prefix === 'string' && prefix ? prefix : ''
        const entries: Array<{ key: string; value: unknown }> = []
        for (const [key, value] of this.store.entries()) {
            if (!p || key.startsWith(p)) {
                entries.push({ key, value })
            }
        }
        return entries
    }
}
