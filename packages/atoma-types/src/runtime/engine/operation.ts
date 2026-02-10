import type { OperationContext, OperationOrigin } from '../../core'

export type OperationEngine = Readonly<{
    createContext: (
        ctx: OperationContext | undefined,
        options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
    ) => OperationContext
}>
