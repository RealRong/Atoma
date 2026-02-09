import type { OperationContext, OperationOrigin } from '../../core'

export type RuntimeOperation = Readonly<{
    createContext: (
        ctx: OperationContext | undefined,
        options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
    ) => OperationContext
}>
