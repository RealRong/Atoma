import type { ServerPlugin } from '../engine/plugins'
import { createOpsRoute } from '../routes/ops/createOpsRoute'
import { createBatchRestRoute } from '../routes/batch/createBatchRestRoute'
import { createSyncPullRoute } from '../routes/sync/createSyncPullRoute'
import { createSyncSubscribeRoute } from '../routes/sync/createSyncSubscribeRoute'
import { createSyncSubscribeVNextRoute } from '../routes/sync/createSyncSubscribeVNextRoute'
import { createSyncPushRoute } from '../routes/sync/createSyncPushRoute'

export function createDefaultRoutesPlugin<Ctx>(): ServerPlugin<Ctx> {
    return {
        name: 'default-routes',
        setup: ({ services, routing }) => {
            return {
                routes: [
                    createSyncPullRoute({ services, enabled: routing.syncEnabled, pullPath: routing.syncPullPath }),
                    createSyncSubscribeVNextRoute({ services, enabled: routing.syncEnabled, subscribePath: routing.syncSubscribeVNextPath }),
                    createSyncSubscribeRoute({ services, enabled: routing.syncEnabled, subscribePath: routing.syncSubscribePath }),
                    createSyncPushRoute({ services, enabled: routing.syncEnabled, pushPath: routing.syncPushPath }),
                    createOpsRoute({ services, enabled: true, opsPath: routing.opsPath }),
                    createBatchRestRoute({ services })
                ]
            }
        }
    }
}
