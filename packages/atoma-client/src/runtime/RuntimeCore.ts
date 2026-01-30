import type { ObservabilityContext } from 'atoma-observability'
import type { Query, WriteAction, WriteItem, WriteResultData } from 'atoma-protocol'
import type { QueryResult } from '../plugins/types'
import { HandlerChain } from '../plugins/HandlerChain'
import { PluginRegistry } from '../plugins/PluginRegistry'

export class RuntimeCore {
    readonly io: HandlerChain

    constructor(args: { registry: PluginRegistry }) {
        this.io = new HandlerChain(args.registry.list('io'))
    }

    query = async (_args: { store: string; query: Query; context?: ObservabilityContext }): Promise<QueryResult> => {
        throw new Error('[Atoma] RuntimeCore.query 尚未实现')
    }

    write = async (_args: {
        store: string
        action: WriteAction
        items: WriteItem[]
        context?: ObservabilityContext
    }): Promise<WriteResultData> => {
        throw new Error('[Atoma] RuntimeCore.write 尚未实现')
    }
}
