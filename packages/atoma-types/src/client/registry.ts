export type CapabilityKey<T> = Readonly<{
    key: string
    __capabilityType?: (value: T) => T
}>

export type CapabilityToken<T = unknown> = string | CapabilityKey<T>

export function defineCapability<T>(key: string): CapabilityKey<T> {
    const normalized = String(key ?? '').trim()
    if (!normalized) {
        throw new Error('[Atoma] defineCapability: key 必填')
    }
    return { key: normalized } as CapabilityKey<T>
}

export type CapabilitiesRegistry = Readonly<{
    register: {
        <T>(key: CapabilityKey<T>, value: T): () => void
        (key: string, value: unknown): () => void
    }
    get: {
        <T>(key: CapabilityKey<T>): T | undefined
        <T = unknown>(key: string): T | undefined
    }
    list: (prefix?: string) => Array<{ key: string; value: unknown }>
}>
