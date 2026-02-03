export class CapabilitiesRegistry {
    private readonly store = new Map<string, unknown>()

    register = (key: string, value: unknown) => {
        const k = String(key ?? '').trim()
        if (!k) throw new Error('[Atoma] CapabilitiesRegistry.register: key 必填')
        this.store.set(k, value)
        return () => {
            if (this.store.get(k) === value) {
                this.store.delete(k)
            }
        }
    }

    get = <T = unknown>(key: string): T | undefined => {
        const k = String(key ?? '').trim()
        if (!k) return undefined
        return this.store.get(k) as T | undefined
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
