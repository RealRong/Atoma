import type { ObservabilityContext } from 'atoma-observability'
import { ClientPlugin } from '../plugins'
import type { ObserveHandler, PluginContext, Register } from '../plugins'

export class DefaultObservePlugin extends ClientPlugin {
    readonly id = 'defaults:observe'

    setup(ctx: PluginContext, register: Register) {
        const baseObserve = ctx.runtime.observe
        if (!baseObserve || typeof baseObserve.createContext !== 'function') {
            throw new Error('[Atoma] DefaultObservePlugin: runtime.observe 未就绪')
        }

        const handler: ObserveHandler = (req, _ctx, _next): ObservabilityContext => {
            return baseObserve.createContext(req.storeName ?? 'store', {
                ...(req.traceId ? { traceId: req.traceId } : {}),
                ...(req.explain !== undefined ? { explain: req.explain } : {})
            })
        }

        register('observe', handler, { priority: 1000 })
    }
}
