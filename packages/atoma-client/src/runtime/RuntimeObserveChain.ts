import type { ObservabilityContext } from 'atoma-observability'
import type { DebugConfig, DebugEvent } from 'atoma-observability'
import type { RuntimeObservability, StoreToken } from 'atoma-core'
import type { HandlerEntry } from '../plugins/types'
import type { ObserveContext, ObserveHandler, ObserveRequest } from '../plugins/types'

export class RuntimeObserveChain implements RuntimeObservability {
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

        const run = (index: number): ObservabilityContext => {
            const handler = this.handlers[index]
            if (!handler) {
                throw new Error('[Atoma] ObserveChain: missing terminal handler')
            }
            return handler(req, ctx, () => run(index + 1))
        }

        return run(0)
    }

    registerStore = (args: { storeName: StoreToken; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => {
        this.base?.registerStore?.(args)
    }
}
