import type { Entity, Query } from 'atoma-types/core'
import type { Io, StoreHandle } from 'atoma-types/runtime'
import type { PluginReadResult, ReadContext, ReadRequest } from 'atoma-types/client/plugins'
import type { HandlerChain } from './HandlerChain'

export class PluginRuntimeIo implements Io {
    private readonly readChain: HandlerChain<'read'>
    private readonly clientId: string

    constructor(args: {
        read: HandlerChain<'read'>
        clientId: string
    }) {
        this.readChain = args.read
        this.clientId = args.clientId
    }

    query: Io['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        signal?: AbortSignal
    ): Promise<PluginReadResult> => {
        const req: ReadRequest = {
            storeName: handle.storeName,
            query,
            ...(signal ? { signal } : {})
        }
        const ctx: ReadContext = {
            clientId: this.clientId,
            storeName: String(handle.storeName)
        }
        return await this.readChain.execute(req, ctx)
    }
}
