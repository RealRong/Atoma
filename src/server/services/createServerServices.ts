import type { AtomaServerConfig } from '../config'
import type { AtomaServerServices, ServerRuntimeServices } from './types'
import { createAuthzPolicy } from '../policies/authzPolicy'
import { createSyncService } from './sync/createSyncService'
import { createOpsService } from './ops/createOpsService'
import { readJsonBodyWithLimit } from '../http/body'

export function createServerServices<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    runtime: ServerRuntimeServices<Ctx>
    routing: {
        syncEnabled: boolean
    }
}): AtomaServerServices<Ctx> {
    const authz = createAuthzPolicy(args.config)
    const readBodyJson = (incoming: any) => readJsonBodyWithLimit(incoming, args.config.limits?.bodyBytes)

    return {
        config: args.config,
        runtime: args.runtime,
        authz,
        sync: createSyncService({
            config: args.config,
            authz,
        }),
        ops: createOpsService({
            config: args.config,
            authz,
            readBodyJson,
            syncEnabled: args.routing.syncEnabled
        })
    }
}
