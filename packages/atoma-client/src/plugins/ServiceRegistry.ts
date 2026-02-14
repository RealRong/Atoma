import type { ServiceRegistry as ServiceRegistryType, ServiceToken } from 'atoma-types/client/services'

function assertToken(token: ServiceToken<unknown>): symbol {
    if (typeof token !== 'symbol') {
        throw new Error('[Atoma] ServiceRegistry.register: token 必须是 symbol')
    }
    return token
}

export class ServiceRegistry implements ServiceRegistryType {
    private readonly store = new Map<symbol, unknown>()

    register = <TToken extends ServiceToken<unknown>>(
        token: TToken,
        value: TToken extends ServiceToken<infer TValue> ? TValue : never,
        opts?: { override?: boolean }
    ): (() => void) => {
        const normalizedToken = assertToken(token as ServiceToken<unknown>)
        const hasPrevious = this.store.has(normalizedToken)
        if (hasPrevious && opts?.override !== true) {
            throw new Error(`[Atoma] ServiceRegistry.register: service 冲突: ${String(normalizedToken.description ?? 'unknown')}`)
        }
        const previous = hasPrevious ? this.store.get(normalizedToken) : undefined

        this.store.set(normalizedToken, value)

        return () => {
            if (this.store.get(normalizedToken) === value) {
                if (hasPrevious) {
                    this.store.set(normalizedToken, previous)
                } else {
                    this.store.delete(normalizedToken)
                }
            }
        }
    }

    resolve = <TToken extends ServiceToken<unknown>>(
        token: TToken
    ): (TToken extends ServiceToken<infer TValue> ? TValue : never) | undefined => {
        const normalizedToken = assertToken(token as ServiceToken<unknown>)
        return this.store.get(normalizedToken) as (TToken extends ServiceToken<infer TValue> ? TValue : never) | undefined
    }
}
