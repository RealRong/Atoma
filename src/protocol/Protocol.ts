import { error } from './error'
import { ops } from './ops'
import { sse } from './sse'
import { trace } from './trace'

export const Protocol = {
    trace,
    error,
    ops,
    sse,
    collab: {}
} as const
