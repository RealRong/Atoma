import type { Entity } from 'atoma-types/core'
import type { RemoteOpEnvelope, RemoteOpResultEnvelope } from 'atoma-types/client/ops'
import type {
    HandlerEntry,
    HandlerMap,
    HandlerName,
    OpsContext,
    PersistContext,
    PluginReadResult,
    ReadContext,
    ReadRequest
} from 'atoma-types/client/plugins'
import type { PersistRequest, PersistResult } from 'atoma-types/runtime'
import { HandlerChain, markTerminalResult } from './HandlerChain'

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

type HandlerVersionMap = {
    [K in HandlerName]: number
}

const terminalByName = {
    ops: () => markTerminalResult({ results: [] }),
    persist: () => markTerminalResult({ status: 'confirmed' as const }),
    read: () => markTerminalResult({ data: [] })
}

export class PluginRegistry {
    private readonly entries: StoredEntries = {
        ops: [],
        persist: [],
        read: []
    }
    private order = 0
    private readonly versions: HandlerVersionMap = {
        ops: 0,
        persist: 0,
        read: 0
    }
    private readonly chainCache = new Map<HandlerName, {
        version: number
        chain: HandlerChain<any>
    }>()

    private invalidate(name: HandlerName): void {
        this.versions[name] += 1
        this.chainCache.delete(name)
    }

    private getChain<K extends HandlerName>(name: K): HandlerChain<K> {
        const version = this.versions[name]
        const cached = this.chainCache.get(name)
        if (cached && cached.version === version) {
            return cached.chain as HandlerChain<K>
        }

        const entries = this.list(name)
        if (!entries.length) {
            throw new Error(`[Atoma] ${String(name)} handler missing`)
        }

        const chain = new HandlerChain(entries, {
            name: String(name),
            terminal: terminalByName[name] as unknown as ChainTerminal<K>
        })

        this.chainCache.set(name, {
            version,
            chain
        })

        return chain
    }

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
        this.invalidate(name)

        return () => {
            const index = list.indexOf(entry)
            if (index >= 0) {
                list.splice(index, 1)
                this.invalidate(name)
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
    }): Promise<ChainRes<K>> => {
        return await this.getChain(args.name).execute(args.req, args.ctx)
    }

    executeOps = async (args: {
        req: RemoteOpEnvelope
        ctx: OpsContext
    }): Promise<RemoteOpResultEnvelope> => {
        return await this.execute({
            name: 'ops',
            req: args.req,
            ctx: args.ctx
        })
    }

    executeRead = async (args: {
        req: ReadRequest
        ctx: ReadContext
    }): Promise<PluginReadResult> => {
        return await this.execute({
            name: 'read',
            req: args.req,
            ctx: args.ctx
        })
    }

    executePersist = async <T extends Entity>(args: {
        req: PersistRequest<T>
        ctx: PersistContext
    }): Promise<PersistResult<T>> => {
        return await this.execute({
            name: 'persist',
            req: args.req as unknown as ChainReq<'persist'>,
            ctx: args.ctx as ChainCtx<'persist'>
        }) as PersistResult<T>
    }

    clear = () => {
        this.entries.ops.length = 0
        this.entries.persist.length = 0
        this.entries.read.length = 0

        this.versions.ops += 1
        this.versions.persist += 1
        this.versions.read += 1
        this.chainCache.clear()
    }
}
