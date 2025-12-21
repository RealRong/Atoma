import type { ObservabilityContext } from '#observability'

export type AdapterRequestEvent = {
    method: string
    endpoint: string
    attempt: number
    payloadBytes?: number
}

export type AdapterResponseEvent = {
    ok: boolean
    status?: number
    durationMs?: number
    itemCount?: number
}

export async function withAdapterEvents<T>(
    ctx: ObservabilityContext | undefined,
    request: Omit<AdapterRequestEvent, 'attempt'> & { attempt?: number },
    run: (args: { startedAt: number }) => Promise<{ result: T; response?: Response; itemCount?: number }>
): Promise<T> {
    const attempt = typeof request.attempt === 'number' ? request.attempt : 1

    const shouldEmit = Boolean(ctx?.active)
    const startedAt = shouldEmit ? Date.now() : 0

    ctx?.emit('adapter:request', {
        method: request.method,
        endpoint: request.endpoint,
        attempt,
        payloadBytes: request.payloadBytes
    })

    try {
        const { result, response, itemCount } = await run({ startedAt })
        ctx?.emit('adapter:response', {
            ok: response?.ok ?? true,
            status: response?.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined,
            itemCount
        })
        return result
    } catch (error) {
        const status = typeof (error as any)?.status === 'number'
            ? (error as any).status
            : undefined
        ctx?.emit('adapter:response', {
            ok: false,
            status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })
        throw error
    }
}

