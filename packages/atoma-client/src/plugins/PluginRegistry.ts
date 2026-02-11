import type { HandlerEntry, HandlerMap, HandlerName } from 'atoma-types/client/plugins'
import { HandlerChain } from './HandlerChain'

type StoredEntry<K extends HandlerName> = {
    handler: HandlerMap[K]
    priority: number
    order: number
}

type StoredEntries = {
    [K in HandlerName]: Array<StoredEntry<K>>
}

type ChainReq<K extends HandlerName> = Parameters<HandlerMap[K]>[0]
type ChainCtx<K extends HandlerName> = Parameters<HandlerMap[K]>[1]
type ChainRes<K extends HandlerName> = Awaited<ReturnType<HandlerMap[K]>>
type ChainTerminal<K extends HandlerName> = (
    req: ChainReq<K>,
    ctx: ChainCtx<K>
) => Promise<ChainRes<K>> | ChainRes<K>

export class PluginRegistry {
    private readonly entries: StoredEntries = {
        ops: [],
        persist: [],
        read: []
    }
    private order = 0

    register = <K extends HandlerName>(
        name: K,
        handler: HandlerMap[K],
        opts?: { priority?: number }
    ) => {
        const list = this.entries[name] as Array<StoredEntry<K>>
        const priority = (typeof opts?.priority === 'number' && Number.isFinite(opts.priority)) ? opts.priority : 0
        const entry: StoredEntry<K> = {
            handler,
            priority,
            order: this.order++
        }

        list.push(entry)

        return () => {
            const index = list.indexOf(entry)
            if (index >= 0) {
                list.splice(index, 1)
            }
        }
    }

    list = <K extends HandlerName>(name: K): HandlerEntry<K>[] => {
        const current = this.entries[name] as Array<StoredEntry<K>>
        const sorted = [...current].sort((left, right) => {
            if (left.priority !== right.priority) return left.priority - right.priority
            return left.order - right.order
        })

        return sorted.map(entry => ({
            handler: entry.handler,
            priority: entry.priority
        }))
    }

    execute = async <K extends HandlerName>(args: {
        name: K
        req: ChainReq<K>
        ctx: ChainCtx<K>
        terminal: ChainTerminal<K>
    }): Promise<ChainRes<K>> => {
        const entries = this.list(args.name)
        if (!entries.length) {
            throw new Error(`[Atoma] ${String(args.name)} handler missing`)
        }

        return await new HandlerChain(entries, {
            name: String(args.name),
            terminal: args.terminal
        }).execute(args.req, args.ctx)
    }

    clear = () => {
        this.entries.ops.length = 0
        this.entries.persist.length = 0
        this.entries.read.length = 0
    }
}
