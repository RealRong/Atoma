import * as errorFns from './fns'

export const error = {
    create: errorFns.create,
    createError: errorFns.createError,
    withTrace: errorFns.withTrace,
    withDetails: errorFns.withDetails,
    wrap: errorFns.wrap,
    inferKindFromCode: errorFns.inferKindFromCode
} as const

export type { ErrorKind, StandardErrorDetails, StandardError } from './types'

