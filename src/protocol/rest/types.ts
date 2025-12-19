import type { BatchRequest } from '../batch/types'
import type { StandardError } from '../error/types'

export type IncomingHttp = {
    method: string
    url: string
    headers?: Record<string, string>
    json?: () => Promise<any>
    text?: () => Promise<string>
    body?: any
}

export type RestRoute =
    | { kind: 'batch'; method: string; pathname: string }
    | { kind: 'rest'; method: string; pathname: string; resource?: string; id?: string }

export type ParseOutcome =
    | { ok: true; request: BatchRequest; route: RestRoute }
    | { ok: false; status: number; error: StandardError }
    | { ok: 'pass' }

export type BodyReader = (incoming: IncomingHttp) => Promise<any>

export type ParseOptions = {
    batchPath?: string
    enableRest?: boolean
    bodyReader?: BodyReader
    traceIdHeader?: string
    requestIdHeader?: string
}
