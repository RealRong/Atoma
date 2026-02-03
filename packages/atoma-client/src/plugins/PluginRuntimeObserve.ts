import type { Types } from 'atoma-core'
import type { RuntimeObservability } from 'atoma-runtime'
import type { HandlerEntry, ObserveContext, ObserveHandler, ObserveRequest } from './types'

export class PluginRuntimeObserve implements RuntimeObservability {
    private readonly handlers: ObserveHandler[]
    private readonly clientId: string
    private readonly base?: RuntimeObservability

    constructor(args: {
        entries: HandlerEntry[]
        clientId: string
        base?: RuntimeObservability
    }) {
        this.handlers = args.entries.map(entry => entry.handler as ObserveHandler)
        this.clientId = args.clientId
        this.base = args.base
    }

    createContext: RuntimeObservability['createContext'] = (storeName, ctxArgs) => {
        const req: ObserveRequest = {
            storeName,
            ...(ctxArgs?.traceId ? { traceId: ctxArgs.traceId } : {}),
            ...(ctxArgs?.explain !== undefined ? { explain: ctxArgs.explain } : {})
        }
        const ctx: ObserveContext = { clientId: this.clientId }

        const run = (index: number): Types.ObservabilityContext => {
            const handler = this.handlers[index]
            if (!handler) {
                throw new Error('[Atoma] ObserveChain: missing terminal handler')
            }
            return handler(req, ctx, () => run(index + 1))
        }

        return run(0)
    }

    registerStore = (args: { storeName: Types.StoreToken; debug?: Types.DebugConfig; debugSink?: (e: Types.DebugEvent) => void }) => {
        this.base?.registerStore?.(args)
    }
}
