import type { BatchRequest, StandardError } from '../types'

export type IncomingHttp = {
    method: string
    url: string
    headers?: Record<string, string>
    json?: () => Promise<any>
    text?: () => Promise<string>
    body?: any
}

export type ParsedOk = {
    ok: true
    request: BatchRequest
    context: any
    route:
        | {
            kind: 'batch'
            method: string
            pathname: string
        }
        | {
            kind: 'rest'
            method: string
            pathname: string
            resource?: string
            id?: string
        }
}

export type ParsedError = {
    ok: false
    httpStatus: number
    error: StandardError
}

export type ParsedPass = {
    ok: 'pass'
}

export type ParsedOutcome = ParsedOk | ParsedError | ParsedPass

export type BodyReader = (incoming: IncomingHttp) => Promise<any>

export interface ParserOptions {
    batchPath?: string
    enableRest?: boolean
    buildContext?: (incoming: IncomingHttp) => Promise<any> | any
    bodyReader?: BodyReader
    traceIdHeader?: string
    requestIdHeader?: string
}
