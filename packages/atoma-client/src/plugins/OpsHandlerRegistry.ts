import type { RemoteOpEnvelope, RemoteOpResultEnvelope } from 'atoma-types/client/ops'
import type { OpsEntry, OpsHandler, OpsContext } from 'atoma-types/client/plugins'
import { OpsChain, markTerminalResult } from './OpsChain'

type StoredEntry = {
    handler: OpsHandler
    priority: number
    order: number
}

type ChainTerminal = (
    req: RemoteOpEnvelope,
    ctx: OpsContext
) => Promise<RemoteOpResultEnvelope> | RemoteOpResultEnvelope

const terminal: ChainTerminal = () => markTerminalResult({ results: [] })

export class OpsHandlerRegistry {
    private readonly entries: StoredEntry[] = []
    private order = 0
    private version = 0
    private chainCache?: {
        version: number
        chain: OpsChain
    }

    private invalidate(): void {
        this.version += 1
        this.chainCache = undefined
    }

    private getChain(): OpsChain {
        const cached = this.chainCache
        if (cached && cached.version === this.version) {
            return cached.chain
        }

        const entries = this.list()
        if (!entries.length) {
            throw new Error('[Atoma] ops handler missing')
        }

        const chain = new OpsChain(entries, {
            name: 'ops',
            terminal
        })

        this.chainCache = {
            version: this.version,
            chain
        }

        return chain
    }

    register = (
        handler: OpsHandler,
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

    list = (): OpsEntry[] => {
        const sorted = [...this.entries].sort((left, right) => {
            if (left.priority !== right.priority) return left.priority - right.priority
            return left.order - right.order
        })

        return sorted.map(entry => ({
            handler: entry.handler,
            priority: entry.priority
        }))
    }

    executeOps = async (args: {
        req: RemoteOpEnvelope
        ctx: OpsContext
    }): Promise<RemoteOpResultEnvelope> => {
        return await this.getChain().execute(args.req, args.ctx)
    }

    clear = () => {
        this.entries.length = 0
        this.invalidate()
    }
}
