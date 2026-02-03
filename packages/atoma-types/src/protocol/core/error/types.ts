import type { EntityId, Version } from '../scalars'

export type ErrorKind =
    | 'validation'
    | 'auth'
    | 'limits'
    | 'conflict'
    | 'not_found'
    | 'adapter'
    | 'internal'

export type ValidationErrorDetails = {
    field?: string
    path?: string
    part?: string
    reason?: string
    [k: string]: unknown
}

export type LimitsErrorDetails = {
    max?: number
    actual?: number
    windowMs?: number
    [k: string]: unknown
}

export type ConflictErrorDetails = {
    resource: string
    entityId: EntityId
    currentVersion?: Version
    hint?: 'rebase' | 'server-wins' | 'manual'
    [k: string]: unknown
}

export type NotFoundErrorDetails = {
    resource: string
    entityId?: EntityId
    [k: string]: unknown
}

export type StandardErrorDetails =
    | ValidationErrorDetails
    | LimitsErrorDetails
    | ConflictErrorDetails
    | NotFoundErrorDetails
    | Record<string, unknown>

export type StandardError = {
    code: string
    message: string
    kind: ErrorKind
    retryable?: boolean
    details?: StandardErrorDetails
    cause?: StandardError
}

