import { createIdempotencyKey, createOpId } from './fns'

export const ids = {
    createIdempotencyKey,
    createOpId
} as const

