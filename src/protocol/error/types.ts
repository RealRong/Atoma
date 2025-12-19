export type ErrorKind =
    | 'field_policy'
    | 'validation'
    | 'access'
    | 'limits'
    | 'adapter'
    | 'executor'
    | 'conflict'
    | 'internal'

export type StandardErrorDetails = {
    kind: ErrorKind
    traceId?: string
    requestId?: string
    opId?: string
    resource?: string
    part?: 'where' | 'orderBy' | 'select' | string
    field?: string
    path?: string
    queryIndex?: number
    max?: number
    actual?: number
    currentValue?: unknown
    currentVersion?: number
    [k: string]: any
}

export type StandardError = {
    code: string
    message: string
    details?: StandardErrorDetails
}
