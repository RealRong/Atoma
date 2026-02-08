import type { HandlerEntry, HandlerMap, HandlerName } from 'atoma-types/client'

const TERMINAL_RESULT_SYMBOL = Symbol.for('atoma.client.handler-chain.terminal-result')

type TerminalResultMarker = {
    [TERMINAL_RESULT_SYMBOL]?: true
}

type ChainReq<K extends HandlerName> = Parameters<HandlerMap[K]>[0]
type ChainCtx<K extends HandlerName> = Parameters<HandlerMap[K]>[1]
type ChainRes<K extends HandlerName> = Awaited<ReturnType<HandlerMap[K]>>
type ChainHandler<K extends HandlerName> = (
    req: ChainReq<K>,
    ctx: ChainCtx<K>,
    next: () => Promise<ChainRes<K>>
) => Promise<ChainRes<K>>

type ChainTerminal<K extends HandlerName> = (
    req: ChainReq<K>,
    ctx: ChainCtx<K>
) => Promise<ChainRes<K>> | ChainRes<K>

export function markTerminalResult<T extends Record<string, unknown>>(result: T): T {
    Object.defineProperty(result, TERMINAL_RESULT_SYMBOL, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    })
    return result
}

export function isTerminalResult(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false
    return (result as TerminalResultMarker)[TERMINAL_RESULT_SYMBOL] === true
}

export class HandlerChain<K extends HandlerName = HandlerName> {
    private readonly entries: HandlerEntry<K>[]
    private readonly name: string
    private readonly terminal?: ChainTerminal<K>

    constructor(
        entries: HandlerEntry<K>[],
        options?: {
            name?: string
            terminal?: ChainTerminal<K>
        }
    ) {
        this.entries = Array.isArray(entries) ? [...entries] : []
        this.name = options?.name ?? 'anonymous'
        this.terminal = options?.terminal
    }

    private getHandler(index: number): ChainHandler<K> | undefined {
        return this.entries[index]?.handler as unknown as ChainHandler<K> | undefined
    }

    execute = async (req: ChainReq<K>, ctx: ChainCtx<K>): Promise<ChainRes<K>> => {
        const run = async (index: number): Promise<ChainRes<K>> => {
            const handler = this.getHandler(index)
            if (!handler) {
                if (!this.terminal) {
                    throw new Error(`[Atoma] HandlerChain(${this.name}): missing terminal handler`)
                }
                return await this.terminal(req, ctx)
            }

            return await handler(req, ctx, () => run(index + 1))
        }

        return await run(0)
    }
}
