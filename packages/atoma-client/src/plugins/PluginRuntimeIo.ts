import type { Entity, Query } from 'atoma-types/core'
import type { Io, StoreHandle } from 'atoma-types/runtime'
import type { PluginReadResult, ReadContext, ReadRequest } from 'atoma-types/client/plugins'
import { markTerminalResult } from './HandlerChain'
import { PluginRegistry } from './PluginRegistry'

export class PluginRuntimeIo implements Io {
    private readonly clientId: string
    private readonly pluginRegistry: PluginRegistry

    constructor(args: {
        clientId: string
        pluginRegistry: PluginRegistry
    }) {
        this.clientId = args.clientId
        this.pluginRegistry = args.pluginRegistry
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

        return await this.pluginRegistry.execute({
            name: 'read',
            req,
            ctx,
            terminal: () => markTerminalResult({ data: [] })
        })
    }
}
