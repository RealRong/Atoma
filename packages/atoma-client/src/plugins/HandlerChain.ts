import type { HandlerEntry } from './types'

export class HandlerChain {
    private readonly entries: HandlerEntry[]

    constructor(entries: HandlerEntry[]) {
        this.entries = Array.isArray(entries) ? [...entries] : []
    }

    execute = async <TReq, TCtx, TRes>(req: TReq, ctx: TCtx): Promise<TRes> => {
        const handlers = this.entries.map(entry => entry.handler) as unknown as Array<(
            req: TReq,
            ctx: TCtx,
            next: () => Promise<TRes>
        ) => Promise<TRes>>

        const run = async (index: number): Promise<TRes> => {
            const handler = handlers[index]
            if (!handler) {
                throw new Error('[Atoma] HandlerChain: missing terminal handler')
            }
            return await handler(req, ctx, () => run(index + 1))
        }

        return await run(0)
    }
}
