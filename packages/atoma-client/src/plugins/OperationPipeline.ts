import type { RemoteOperationEnvelope, RemoteOperationResultEnvelope } from 'atoma-types/client/ops'
import type { OperationMiddleware, OperationContext } from 'atoma-types/client/plugins'

const TERMINAL_RESULT_SYMBOL = Symbol.for('atoma.client.operations-chain.terminal-result')

type TerminalResultMarker = {
    [TERMINAL_RESULT_SYMBOL]?: true
}

type StoredEntry = {
    handler: OperationMiddleware
    priority: number
    order: number
}

type ChainTerminal = (
    req: RemoteOperationEnvelope,
    ctx: OperationContext
) => Promise<RemoteOperationResultEnvelope> | RemoteOperationResultEnvelope

type OperationRunner = (
    req: RemoteOperationEnvelope,
    ctx: OperationContext
) => Promise<RemoteOperationResultEnvelope>

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

const terminal: ChainTerminal = () => markTerminalResult({ results: [] })

export class OperationPipeline {
    private readonly entries: StoredEntry[] = []
    private order = 0
    private version = 0
    private runnerCache?: {
        version: number
        runner: OperationRunner
    }

    private invalidate(): void {
        this.version += 1
        this.runnerCache = undefined
    }

    private listEntries(): StoredEntry[] {
        return [...this.entries].sort((left, right) => {
            if (left.priority !== right.priority) return left.priority - right.priority
            return left.order - right.order
        })
    }

    private getRunner(): OperationRunner {
        const cached = this.runnerCache
        if (cached && cached.version === this.version) {
            return cached.runner
        }

        const entries = this.listEntries()
        if (!entries.length) {
            throw new Error('[Atoma] operation middleware missing')
        }

        const runAt = async (
            index: number,
            req: RemoteOperationEnvelope,
            ctx: OperationContext
        ): Promise<RemoteOperationResultEnvelope> => {
            const entry = entries[index]
            if (!entry) {
                return await terminal(req, ctx)
            }

            return await entry.handler(req, ctx, async () => {
                return await runAt(index + 1, req, ctx)
            })
        }

        const runner: OperationRunner = async (req, ctx) => {
            return await runAt(0, req, ctx)
        }

        this.runnerCache = {
            version: this.version,
            runner
        }

        return runner
    }

    register = (
        handler: OperationMiddleware,
        opts?: { priority?: number }
    ) => {
        const priority = (typeof opts?.priority === 'number' && Number.isFinite(opts.priority)) ? opts.priority : 0
        const entry: StoredEntry = {
            handler,
            priority,
            order: this.order++
        }

        this.entries.push(entry)
        this.invalidate()

        return () => {
            const index = this.entries.indexOf(entry)
            if (index >= 0) {
                this.entries.splice(index, 1)
                this.invalidate()
            }
        }
    }

    executeOperations = async (args: {
        req: RemoteOperationEnvelope
        ctx: OperationContext
    }): Promise<RemoteOperationResultEnvelope> => {
        return await this.getRunner()(args.req, args.ctx)
    }

    clear = () => {
        this.entries.length = 0
        this.invalidate()
    }
}
