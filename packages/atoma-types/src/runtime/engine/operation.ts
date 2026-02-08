import type { OperationContext, OperationOrigin } from '../../core'

export type RuntimeOperation = Readonly<{
    normalizeContext: (
        ctx: OperationContext | undefined,
        options?: { defaultScope?: string; defaultOrigin?: OperationOrigin }
    ) => OperationContext
}>
