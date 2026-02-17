import { createActionId } from 'atoma-shared'
import type { ActionContext, ActionOrigin } from 'atoma-types/core'

export function createActionContext(
    context?: Partial<ActionContext>,
    options?: { defaultScope?: string; defaultOrigin?: ActionOrigin; now?: () => number }
): ActionContext {
    const now = options?.now ?? Date.now
    const scope = String(context?.scope ?? options?.defaultScope ?? 'default')
    const origin = (context?.origin ?? options?.defaultOrigin ?? 'user') as ActionOrigin
    const id = context?.id ?? createActionId(now)
    const timestamp = context?.timestamp ?? now()

    return {
        scope,
        origin,
        id,
        label: context?.label,
        timestamp
    }
}
