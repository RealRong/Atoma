import type { ServerPlugin } from '../engine/plugins'
import { createOpsRoute } from '../routes/ops/createOpsRoute'
import { createSyncSubscribeVNextRoute } from '../routes/sync/createSyncSubscribeVNextRoute'

export function createDefaultRoutesPlugin<Ctx>(): ServerPlugin<Ctx> {
    return {
        name: 'default-routes',
        setup: ({ services, routing }) => {
            return {
                routes: [
                    createSyncSubscribeVNextRoute({ services, enabled: routing.syncEnabled, subscribePath: routing.syncSubscribeVNextPath }),
                    createOpsRoute({ services, enabled: true, opsPath: routing.opsPath }),
                ]
            }
        }
    }
}
