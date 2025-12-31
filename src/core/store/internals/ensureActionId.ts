import { createActionId } from '../../operationContext'
import type { OperationContext } from '../../types'

export function ensureActionId(opContext: OperationContext | undefined): OperationContext | undefined {
    if (!opContext) {
        return {
            scope: 'default',
            origin: 'user',
            actionId: createActionId()
        }
    }
    if (typeof opContext.actionId === 'string' && opContext.actionId) return opContext
    return {
        ...opContext,
        actionId: createActionId()
    }
}
