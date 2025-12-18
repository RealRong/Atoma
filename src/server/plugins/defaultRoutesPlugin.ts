import type { ServerPlugin } from '../engine/plugins'
import { createBatchRestRoute } from '../routes/batch/createBatchRestRoute'
import { createSyncPullRoute } from '../routes/sync/createSyncPullRoute'
import { createSyncSubscribeRoute } from '../routes/sync/createSyncSubscribeRoute'
import { createSyncPushRoute } from '../routes/sync/createSyncPushRoute'

export function createDefaultRoutesPlugin<Ctx>(): ServerPlugin<Ctx> {
    return {
        name: 'default-routes',
        setup: ({ services, routing }) => {
            return {
                routes: [
                    createSyncPullRoute({ services, enabled: routing.syncEnabled, pullPath: routing.syncPullPath }),
                    createSyncSubscribeRoute({ services, enabled: routing.syncEnabled, subscribePath: routing.syncSubscribePath }),
                    createSyncPushRoute({ services, enabled: routing.syncEnabled, pushPath: routing.syncPushPath }),
                    createBatchRestRoute({ services })
                ]
            }
        }
    }
}

