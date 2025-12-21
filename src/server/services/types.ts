import type { SyncPushRequest } from '#protocol'
import type { AtomaServerConfig, AtomaServerRoute } from '../config'
import type { PhaseReporter } from '../engine/types'
import type { ServerRuntime } from '../engine/runtime'
import type { HandleResult } from '../http/types'
import type { AuthzPolicy } from '../policies/authzPolicy'
import type { LimitPolicy } from '../policies/limitPolicy'
import type { CreateRuntime, FormatTopLevelError } from '../engine/types'

export type BatchRestService<Ctx> = {
    handleHttp: (args: {
        incoming: any
        urlRaw: string
        urlForParse: string
        pathname: string
        method: string
    }) => Promise<HandleResult>
}

export type SyncService<Ctx> = {
    pull: (args: {
        urlObj: URL
        method: string
        pathname: string
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        phase: PhaseReporter<Ctx>
    }) => Promise<HandleResult>
    subscribe: (args: {
        incoming: any
        urlObj: URL
        method: string
        pathname: string
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        phase: PhaseReporter<Ctx>
    }) => Promise<HandleResult>
    subscribeVNext: (args: {
        incoming: any
        urlObj: URL
        method: string
        pathname: string
        route: AtomaServerRoute
        runtime: ServerRuntime<Ctx>
        phase: PhaseReporter<Ctx>
    }) => Promise<HandleResult>
    preparePush: (args: {
        incoming: any
        traceIdHeaderValue?: string
        requestIdHeaderValue?: string
    }) => Promise<{
        request: SyncPushRequest
        initialTraceId?: string
        initialRequestId?: string
    }>
    push: (args: {
        incoming: any
        method: string
        pathname: string
        route: AtomaServerRoute
        request: SyncPushRequest
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
    batchRest: BatchRestService<Ctx>
    sync: SyncService<Ctx>
    ops: OpsService<Ctx>
}
