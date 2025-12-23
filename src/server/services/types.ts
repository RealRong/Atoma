import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { PhaseReporter } from '../engine/types'
import type { ServerRuntime } from '../engine/runtime'
import type { HandleResult } from '../http/types'
import type { AuthzPolicy } from '../policies/authzPolicy'
import type { LimitPolicy } from '../policies/limitPolicy'
import type { CreateRuntime, FormatTopLevelError } from '../engine/types'

export type SyncService<Ctx> = {
    subscribeVNext: (args: {
        incoming: any
        urlObj: URL
        method: string
        pathname: string
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        phase: PhaseReporter<Ctx>
    }) => Promise<HandleResult>
}

export type OpsService<Ctx> = {
    handle: (args: {
        incoming: any
        method: string
        pathname: string
        runtime: ServerRuntime<Ctx>
        phase: PhaseReporter<Ctx>
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
    limits: LimitPolicy<Ctx>
    sync: SyncService<Ctx>
    ops: OpsService<Ctx>
}
