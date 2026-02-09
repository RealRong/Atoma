import type { OperationContext, OperationOrigin } from 'atoma-types/core'

type CryptoLike = {
    randomUUID?: () => string
}

const createFallbackId = () =>
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`

export const createActionId = (): string => {
    const cryptoObject = (globalThis as { crypto?: CryptoLike }).crypto
    const uuid = cryptoObject?.randomUUID

    if (typeof uuid === 'function') {
        try {
            return String(uuid.call(cryptoObject))
        } catch {
            // ignore
        }
    }

    return createFallbackId()
}

export type CreateOperationContextInput = Readonly<Partial<OperationContext>>

export function createOperationContext(
    input?: CreateOperationContextInput,
    options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
): OperationContext {
    const scope = String(input?.scope ?? options?.defaultScope ?? 'default')
    const origin = (input?.origin ?? options?.defaultOrigin ?? 'user') as OperationOrigin
    const actionId = input?.actionId ?? createActionId()
    const timestamp = input?.timestamp ?? Date.now()

    return {
        scope,
        origin,
        actionId,
        label: input?.label,
        timestamp
    }
}
