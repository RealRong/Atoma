import type { DevtoolsProvider, DevtoolsProviderInput } from '#client/types'

export const DEVTOOLS_REGISTRY_KEY = Symbol.for('atoma.devtools.registry')

export class DevtoolsRegistry {
    private readonly providers = new Map<string, DevtoolsProvider>()
    private readonly listeners = new Set<(e: { type: 'register' | 'unregister'; key: string }) => void>()

    register = (key: string, providerInput: DevtoolsProviderInput) => {
        const k = String(key ?? '').trim()
        if (!k) throw new Error('[Atoma] devtools.register: key 必填')
        const provider = this.normalizeProvider(providerInput)
        this.providers.set(k, provider)
        this.emit({ type: 'register', key: k })
        return () => {
            if (this.providers.delete(k)) {
                this.emit({ type: 'unregister', key: k })
            }
        }
    }

    get = (key: string) => {
        return this.providers.get(String(key))
    }

    list = () => {
        return Array.from(this.providers.entries()).map(([key, provider]) => ({ key, provider }))
    }

    subscribe = (listener: (e: { type: 'register' | 'unregister'; key: string }) => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    private emit = (e: { type: 'register' | 'unregister'; key: string }) => {
        for (const fn of this.listeners) {
            try {
                fn(e)
            } catch {
                // ignore
            }
        }
    }

    private normalizeProvider = (input: DevtoolsProviderInput): DevtoolsProvider => {
        if (typeof input === 'function') {
            return { snapshot: input }
        }
        const snapshot = (input as any)?.snapshot
        if (typeof snapshot === 'function') return input as DevtoolsProvider
        throw new Error('[Atoma] devtools.register: provider.snapshot 必须是函数')
    }
}
