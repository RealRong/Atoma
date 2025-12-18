import type { RouteHandler } from '../../engine/router'
import type { AtomaServerServices } from '../../services/types'

export function createBatchRestRoute<Ctx>(args: {
    services: AtomaServerServices<Ctx>
}): RouteHandler {
    return {
        id: 'batch/rest',
        match: () => true,
        handle: (ctx) => args.services.batchRest.handleHttp({
            incoming: ctx.incoming,
            urlRaw: ctx.urlRaw,
            urlForParse: ctx.urlForParse,
            pathname: ctx.pathname,
            method: ctx.method
        })
    }
}
