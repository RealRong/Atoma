import type { OperationContext, OperationOrigin } from './types'

const createFallbackId = () =>
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`

export const createActionId = (): string => {
    const cryptoAny = (globalThis as any)?.crypto
    const uuid = cryptoAny?.randomUUID?.bind(cryptoAny)
    if (typeof uuid === 'function') {
        try {
            return String(uuid())
        } catch {
            // ignore
        }
    }
    return createFallbackId()
}

export const normalizeOperationContext = (
    ctx: OperationContext | undefined,
    options?: { defaultScope?: string; defaultOrigin?: OperationOrigin; traceId?: string }
): OperationContext => {
    const scope = (ctx?.scope ?? options?.defaultScope ?? 'default') as string
    const origin = (ctx?.origin ?? options?.defaultOrigin ?? 'user') as OperationOrigin
    const actionId = ctx?.actionId ?? createActionId()
    const timestamp = ctx?.timestamp ?? Date.now()
    const traceId = ctx?.traceId ?? options?.traceId

    return {
        scope,
        origin,
        actionId,
        label: ctx?.label,
        timestamp,
        traceId
    }
}

