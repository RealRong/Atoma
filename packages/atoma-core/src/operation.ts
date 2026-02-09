import { createActionId } from 'atoma-shared'
import type { OperationContext, OperationOrigin } from 'atoma-types/core'

export type CreateOperationContextInput = Readonly<Partial<OperationContext>>

export function createOperationContext(
    input?: CreateOperationContextInput,
    options?: { defaultScope?: string; defaultOrigin?: OperationOrigin; now?: () => number }
): OperationContext {
    const now = options?.now ?? Date.now
    const scope = String(input?.scope ?? options?.defaultScope ?? 'default')
    const origin = (input?.origin ?? options?.defaultOrigin ?? 'user') as OperationOrigin
    const actionId = input?.actionId ?? createActionId(now)
    const timestamp = input?.timestamp ?? now()

    return {
        scope,
        origin,
        actionId,
        label: input?.label,
        timestamp
    }
}
