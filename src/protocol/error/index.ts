import * as errorFns from './fns'

export const error = {
    create: errorFns.create,
    withTrace: errorFns.withTrace,
    withDetails: errorFns.withDetails,
    wrap: errorFns.wrap
} as const

export type {
    ErrorKind,
    StandardErrorDetails,
    StandardError
} from './types'
