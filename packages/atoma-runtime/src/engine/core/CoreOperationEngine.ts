import { createOperationContext } from 'atoma-core/operation'
import type { OperationContext, OperationOrigin } from 'atoma-types/core'
import type { RuntimeOperation } from 'atoma-types/runtime'

export class CoreOperationEngine implements RuntimeOperation {
    createContext = (
        ctx: OperationContext | undefined,
        options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
    ): OperationContext => {
        return createOperationContext(ctx, options)
    }
}
