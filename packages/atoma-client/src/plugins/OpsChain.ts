import type { OpsContext, OpsEntry, OpsHandler } from 'atoma-types/client/plugins'

const TERMINAL_RESULT_SYMBOL = Symbol.for('atoma.client.ops-chain.terminal-result')

type TerminalResultMarker = {
    [TERMINAL_RESULT_SYMBOL]?: true
}

type ChainReq = Parameters<OpsHandler>[0]
type ChainCtx = OpsContext
type ChainRes = Awaited<ReturnType<OpsHandler>>
type ChainHandler = (
    req: ChainReq,
    ctx: ChainCtx,
    next: () => Promise<ChainRes>
) => Promise<ChainRes>

type ChainTerminal = (
    req: ChainReq,
    ctx: ChainCtx
) => Promise<ChainRes> | ChainRes

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

export class OpsChain {
    private readonly entries: OpsEntry[]
    private readonly name: string
    private readonly terminal?: ChainTerminal

    constructor(
        entries: OpsEntry[],
        options?: {
            name?: string
            terminal?: ChainTerminal
        }
    ) {
        this.entries = Array.isArray(entries) ? [...entries] : []
        this.name = options?.name ?? 'anonymous'
        this.terminal = options?.terminal
    }

    private getHandler(index: number): ChainHandler | undefined {
        return this.entries[index]?.handler as ChainHandler | undefined
    }

    execute = async (req: ChainReq, ctx: ChainCtx): Promise<ChainRes> => {
        const run = async (index: number): Promise<ChainRes> => {
            const handler = this.getHandler(index)
            if (!handler) {
                if (!this.terminal) {
                    throw new Error(`[Atoma] OpsChain(${this.name}): missing terminal handler`)
                }
                return await this.terminal(req, ctx)
            }

            return await handler(req, ctx, () => run(index + 1))
        }

        return await run(0)
    }
}
