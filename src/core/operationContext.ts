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

export type CreateOpContextArgs = Readonly<{
    scope: string
    origin?: OperationOrigin
    label?: string
}>

export function createOpContext(args: CreateOpContextArgs): OperationContext {
    return {
        scope: String(args.scope || 'default'),
        origin: args.origin ?? 'user',
        actionId: createActionId(),
        label: args.label,
        timestamp: Date.now()
    }
}

export const normalizeOperationContext = (
    ctx: OperationContext | undefined,
    options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
): OperationContext => {
    const scope = (ctx?.scope ?? options?.defaultScope ?? 'default') as string
    const origin = (ctx?.origin ?? options?.defaultOrigin ?? 'user') as OperationOrigin
    const actionId = ctx?.actionId ?? createActionId()
    const timestamp = ctx?.timestamp ?? Date.now()

    return {
        scope,
        origin,
        actionId,
        label: ctx?.label,
        timestamp
    }
}
