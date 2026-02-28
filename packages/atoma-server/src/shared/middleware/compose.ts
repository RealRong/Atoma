export type Middleware<TContext, TResult> = (
    context: TContext,
    next: () => Promise<TResult>
) => Promise<TResult>

export function composeMiddleware<TContext, TResult>(
    middlewares: Array<Middleware<TContext, TResult>>
): Middleware<TContext, TResult> {
    if (!middlewares.length) {
        return async (_context, next) => next()
    }

    return async (context, next) => {
        const execute = (index: number): Promise<TResult> => (
            index >= middlewares.length
                ? next()
                : middlewares[index]!(context, () => execute(index + 1))
        )

        return execute(0)
    }
}
