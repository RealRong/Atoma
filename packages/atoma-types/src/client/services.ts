declare const SERVICE_TOKEN_TYPE: unique symbol

export type ServiceToken<T> = symbol & {
    readonly [SERVICE_TOKEN_TYPE]?: () => T
}

export function createServiceToken<T>(name: string): ServiceToken<T> {
    const normalized = String(name ?? '').trim()
    if (!normalized) {
        throw new Error('[Atoma] createServiceToken: name 必填')
    }
    return Symbol.for(`atoma.service.${normalized}`) as ServiceToken<T>
}

type ServiceValue<TToken extends ServiceToken<unknown>> =
    TToken extends ServiceToken<infer TValue>
        ? TValue
        : never

export type ServiceRegistry = Readonly<{
    register: <TToken extends ServiceToken<unknown>>(
        token: TToken,
        value: ServiceValue<TToken>,
        opts?: { override?: boolean }
    ) => () => void
    resolve: <TToken extends ServiceToken<unknown>>(token: TToken) => ServiceValue<TToken> | undefined
}>
