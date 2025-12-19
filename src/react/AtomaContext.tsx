import type { PropsWithChildren } from 'react'
import { createContext, useContext, useMemo } from 'react'
import type { AtomaClient, AtomaScopedClient } from '../client/createAtomaClient'
import type { OperationContext, OperationOrigin } from '../core/types'

type AtomaContextValue = {
    client: AtomaClient<any, any>
    ctx: OperationContext
}

const AtomaContext = createContext<AtomaContextValue | null>(null)

export type AtomaContextProviderProps<TClient extends AtomaClient<any, any> = AtomaClient<any, any>> = PropsWithChildren<{
    client?: TClient
    value?: Partial<OperationContext> & {
        scope?: string
        origin?: OperationOrigin
    }
}>

export function AtomaContextProvider<TClient extends AtomaClient<any, any>>(
    props: AtomaContextProviderProps<TClient>
) {
    const parent = useContext(AtomaContext)
    const client = props.client ?? parent?.client
    if (!client) {
        throw new Error('[Atoma] AtomaContextProvider: 缺少 client（请在最外层 Provider 传入 client）')
    }

    const merged = useMemo<AtomaContextValue>(() => {
        const base = parent?.ctx
        const scope = props.value?.scope ?? base?.scope ?? 'default'
        const origin = props.value?.origin ?? base?.origin ?? ('user' as const)

        return {
            client: client as any,
            ctx: {
                scope,
                origin,
                actionId: props.value?.actionId ?? base?.actionId,
                label: props.value?.label ?? base?.label,
                traceId: props.value?.traceId ?? base?.traceId
            }
        }
    }, [client, parent?.ctx, props.value?.actionId, props.value?.label, props.value?.origin, props.value?.scope, props.value?.traceId])

    return (
        <AtomaContext.Provider value={merged}>
            {props.children}
        </AtomaContext.Provider>
    )
}

export function useScopedClient<TClient extends AtomaClient<any, any>>(client: TClient): ReturnType<TClient['scope']>
export function useScopedClient<TClient extends AtomaClient<any, any> = AtomaClient<any, any>>(): AtomaScopedClient<any, any>
export function useScopedClient(client?: AtomaClient<any, any>) {
    const ctxValue = useContext(AtomaContext)
    const resolvedClient = client ?? ctxValue?.client
    if (!resolvedClient) {
        throw new Error('[Atoma] useScopedClient: 缺少 client（请传入 client 或使用 AtomaContextProvider）')
    }

    const baseCtx = ctxValue?.ctx
    const scope = baseCtx?.scope ?? 'default'
    const origin = baseCtx?.origin ?? ('user' as const)

    return resolvedClient.scope(scope, {
        origin,
        actionId: baseCtx?.actionId,
        label: baseCtx?.label,
        traceId: baseCtx?.traceId
    })
}

