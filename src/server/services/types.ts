import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { ServerRuntime } from '../engine/runtime'
import type { HandleResult } from '../http/types'
import type { AuthzPolicy } from '../policies/authzPolicy'
import type { CreateRuntime, FormatTopLevelError } from '../engine/types'

export type SyncService<Ctx> = {
    subscribe: (args: {
        incoming: any
        urlObj: URL
        method: string
        pathname: string
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
    }) => Promise<HandleResult>
}

export type OpsService<Ctx> = {
    handle: (args: {
        incoming: any
        method: string
        pathname: string
        runtime: ServerRuntime<Ctx>
    }) => Promise<HandleResult>
}

export type ServerRuntimeServices<Ctx> = {
    createRuntime: CreateRuntime<Ctx>
    formatTopLevelError: FormatTopLevelError<Ctx>
}

export type AtomaServerServices<Ctx> = {
    config: AtomaServerConfig<Ctx>
    runtime: ServerRuntimeServices<Ctx>
    authz: AuthzPolicy<Ctx>
    sync: SyncService<Ctx>
    ops: OpsService<Ctx>
}
