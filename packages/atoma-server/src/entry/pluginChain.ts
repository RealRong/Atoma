export type PluginRuntime<Ctx> = {
    ctx: Ctx
    traceId?: string
    requestId: string
    logger: any
}

export function composeResponsePlugins<Ctx>(
    plugins: Array<(ctx: any, next: () => Promise<Response>) => Promise<Response>>
) {
    if (!plugins.length) {
        return (_ctx: any, next: () => Promise<Response>) => next()
    }

    return (ctx: any, next: () => Promise<Response>) => {
        const execute = (index: number): Promise<Response> => {
            if (index >= plugins.length) return next()
            return plugins[index](ctx, () => execute(index + 1))
        }

        return execute(0)
    }
}
