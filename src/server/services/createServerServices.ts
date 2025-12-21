import type { AtomaServerConfig } from '../config'
import type { AtomaServerServices, ServerRuntimeServices } from './types'
import { createAuthzPolicy } from '../policies/authzPolicy'
import { createLimitPolicy } from '../policies/limitPolicy'
import { createBatchRestService } from './batchRest/createBatchRestService'
import { createSyncService } from './sync/createSyncService'
import { createOpsService } from './ops/createOpsService'

export function createServerServices<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    runtime: ServerRuntimeServices<Ctx>
    routing: {
        batchPath: string
        restEnabled: boolean
        traceHeader: string
        requestHeader: string
        syncEnabled: boolean
    }
}): AtomaServerServices<Ctx> {
    const authz = createAuthzPolicy(args.config)
    const limits = createLimitPolicy(args.config)

    return {
        config: args.config,
        runtime: args.runtime,
        authz,
        limits,
        batchRest: createBatchRestService({
            config: args.config,
            authz,
            limits,
            ...args.routing,
            ...args.runtime
        }),
        sync: createSyncService({
            config: args.config,
            authz,
            limits
        }),
        ops: createOpsService({
            config: args.config,
            authz,
            limits,
            syncEnabled: args.routing.syncEnabled
        })
    }
}
