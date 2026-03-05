import type {
    AtomaOpMiddlewareContext,
    AtomaOpMiddlewareResult,
    AtomaServerMiddleware
} from '../../config'
import { composeMiddleware } from '../../shared/middleware/compose'

export function createOpMiddlewareRunner<Ctx>(middlewares: Array<NonNullable<AtomaServerMiddleware<Ctx>['onOp']>>) {
    const runMiddlewareChain = composeMiddleware<AtomaOpMiddlewareContext<Ctx>, AtomaOpMiddlewareResult>(middlewares)

    return async (
        ctx: AtomaOpMiddlewareContext<Ctx>,
        next: () => Promise<AtomaOpMiddlewareResult>
    ): Promise<AtomaOpMiddlewareResult> => {
        if (!middlewares.length) return next()

        try {
            return await runMiddlewareChain(ctx, next)
        } catch (error) {
            return { ok: false, error }
        }
    }
}
