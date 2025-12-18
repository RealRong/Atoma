import type { AtomaServerRoute } from '../config'
import type { HandleResult } from '../http/types'
import type { ServerRuntime } from './runtime'

export type CreateRuntime<Ctx> = (args: {
    incoming: any
    route: AtomaServerRoute
    initialTraceId?: string
    initialRequestId?: string
}) => Promise<ServerRuntime<Ctx>>

export type FormatTopLevelError<Ctx> = (args: {
    route?: AtomaServerRoute
    ctx?: Ctx
    requestId?: string
    traceId?: string
    error: unknown
}) => HandleResult

export type PhaseReporter<Ctx> = {
    validated: (args: { request: unknown; event?: any }) => Promise<void>
    authorized: (args?: { event?: any }) => Promise<void>
}
